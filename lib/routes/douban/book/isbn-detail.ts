import { load } from 'cheerio';
import pMap from 'p-map';

import { config } from '@/config';
import type { APIRoute } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';

const mobileBaseUrl = 'https://m.douban.com';
const subjectBaseUrl = 'https://book.douban.com/subject';
const doubanHeaders = {
    Referer: mobileBaseUrl,
    'User-Agent': config.trueUA,
};

type SearchResponse = {
    subjects?: {
        items?: SearchItem[];
    };
};

type SearchItem = {
    target_id?: string;
    target_type?: string;
    target?: {
        id?: string;
        title?: string;
        abstract?: string;
        url?: string;
        uri?: string;
        cover_url?: string;
        card_subtitle?: string;
        rating?: {
            count?: number;
            max?: number;
            star_count?: number;
            value?: number;
        };
        null_rating_reason?: string;
    };
};

type AuthorDetail = {
    name: string;
    id?: string;
    url?: string;
    uri?: string;
    matchedName?: string;
};

export const apiRoute: APIRoute = {
    path: '/book/isbnDetail/:isbn',
    maintainers: ['lyqluis'],
    parameters: {
        isbn: {
            description: 'ISBN 码，例如 `9787541161834`',
        },
    },
    description: '通过 ISBN 搜索豆瓣图书条目，并解析图书详情页返回结构化 JSON。传入 `fetchSeries=true` 时获取丛书信息。',
    handler,
};

async function handler(ctx) {
    const isbn = normalizeIsbn(ctx.req.param('isbn'));
    const shouldFetchSeries = ctx.req.query('fetchSeries') === 'true';

    if (!isbn) {
        return {
            code: 0,
            message: '请提供有效的 ISBN，支持 10 位或 13 位 ISBN。',
        };
    }

    const searchData = await cache.tryGet(`douban:book:isbn:${isbn}`, () => fetchSearchData(isbn), config.cache.routeExpire);
    const searchItem = searchData.subjects?.items?.find((item) => item.target_type === 'book' && (item.target_id || item.target?.id));
    const subjectId = searchItem?.target_id || searchItem?.target?.id;

    if (!subjectId) {
        return {
            code: 0,
            message: `未在豆瓣搜索结果中找到 ISBN ${isbn} 对应的图书条目。`,
        };
    }

    const url = `${subjectBaseUrl}/${subjectId}/`;
    const subjectResponsePromise = got({
        url,
        headers: doubanHeaders,
    });
    const authorDetailsPromise = fetchAuthorDetails(parseSearchItemAuthors(searchItem));
    const [subjectResponse, prefetchedAuthorDetails] = await Promise.all([subjectResponsePromise, authorDetailsPromise]);
    const $ = load(subjectResponse.data);

    return {
        code: 200,
        data: await parseBookDetail($, isbn, subjectId, url, shouldFetchSeries, searchItem, prefetchedAuthorDetails),
    };
}

async function parseBookDetail($, isbn: string, subjectId: string, url: string, shouldFetchSeries: boolean, searchItem?: SearchItem, prefetchedAuthorDetails: AuthorDetail[] = []) {
    const schema = parseJsonLd($);
    const info = parseInfo($);
    const authorNames = uniqueTexts([...(info.authors || []), ...parseSearchItemAuthors(searchItem)]);
    const linkedAuthorDetails = parseLinkedAuthorDetails(info.links, authorNames);
    const authorDetailsPromise = completeAuthorDetails(authorNames, [...linkedAuthorDetails, ...prefetchedAuthorDetails]);
    const seriesPromise = shouldFetchSeries ? parseSeries($, url) : undefined;
    const [authorDetails, series] = await Promise.all([authorDetailsPromise, seriesPromise]);
    const bookInfo = { ...info, authorDetails };
    delete bookInfo.raw;
    const title = normalizeText($('h1.title span[property="v:itemreviewed"]').first().text()) || normalizeText($('meta[property="og:title"]').attr('content')) || schema?.name || searchItem?.target?.title;
    const subtitle = normalizeText($('h2.subtitle span[property="v:subtitle"]').first().text());
    const cover = resolveUrl($('#mainpic a.nbg').attr('href') || $('#mainpic img').attr('src') || $('meta[property="og:image"]').attr('content'), url);
    const summary = getIntroText($, '#link-report');

    return {
        isbn,
        subjectId,
        url,
        mobileUrl: `${mobileBaseUrl}/book/subject/${subjectId}/`,
        title,
        subtitle,
        cover,
        authors: authorDetails,
        info: bookInfo,
        series,
        rating: parseRating($),
        summary,
        authorIntro: getHeadingSectionText($, '作者简介'),
        catalog: parseCatalog($, subjectId),
        blockquotes: parseBlockquotes($, url),
        reviews: parseReviews($, url),
    };
}

async function fetchSearchData(q: string, type = '') {
    const searchUrl = `${mobileBaseUrl}/rexxar/api/v2/search?${new URLSearchParams({
        q,
        type,
        loc_id: '',
        start: '0',
        count: '10',
        sort: 'relevance',
    })}`;

    const searchResponse = await got({
        url: searchUrl,
        headers: doubanHeaders,
    });

    return searchResponse.data as SearchResponse;
}

function parseSearchItemAuthors(searchItem?: SearchItem) {
    const parts = searchItem?.target?.card_subtitle
        ?.split('/')
        .map((item) => normalizeText(item))
        .filter(Boolean);

    if (!parts) {
        return [];
    }

    const authors: string[] = [];

    for (const part of parts) {
        if (isBookMetaPart(part)) {
            break;
        }

        authors.push(part);
    }

    return authors;
}

function isBookMetaPart(value: string) {
    return /^\d{4}/.test(value) || /出版社|出版公司|书局|书店|Press|Books|Publishing/i.test(value);
}

async function completeAuthorDetails(authorNames: string[], knownDetails: AuthorDetail[]) {
    const detailByName = new Map(knownDetails.map((detail) => [detail.name, detail]));
    const missingAuthorNames = authorNames.filter((name) => !detailByName.get(name)?.id);
    const fetchedDetails = await fetchAuthorDetails(missingAuthorNames);

    for (const detail of fetchedDetails) {
        detailByName.set(detail.name, detail);
    }

    return authorNames.map((name) => detailByName.get(name) || { name });
}

function parseLinkedAuthorDetails(links: Array<{ title?: string; url?: string }>, authorNames: string[]) {
    return authorNames.flatMap((name) => {
        const link = links.find((item) => item.title === name);
        const id = extractPersonId(link?.url);

        return id && link?.url ? [{ name, id, url: link.url }] : [];
    });
}

function fetchAuthorDetails(authorNames: string[]) {
    return Promise.all(uniqueTexts(authorNames).map((name) => fetchAuthorDetail(name)));
}

async function fetchAuthorDetail(name: string): Promise<AuthorDetail> {
    try {
        const searchData = await cache.tryGet(`douban:book:author:${name}`, () => fetchSearchData(name, 'person'), config.cache.contentExpire);
        const personItem = searchData.subjects?.items?.find((item) => item.target_type === 'person' && normalizeText(item.target?.title) === name) || searchData.subjects?.items?.find((item) => item.target_type === 'person');
        const id = personItem?.target_id || personItem?.target?.id;

        return {
            name,
            id,
            url: personItem?.target?.url || (id ? `https://www.douban.com/personage/${id}` : undefined),
            uri: personItem?.target?.uri,
            matchedName: personItem?.target?.title,
        };
    } catch {
        return { name };
    }
}

function extractPersonId(url?: string) {
    return url?.match(/\/(?:personage|author)\/(\d+)/)?.[1];
}

function parseJsonLd($) {
    const json = $('script[type="application/ld+json"]').first().text();

    if (!json) {
        return;
    }

    try {
        return JSON.parse(json);
    } catch {
        return;
    }
}

function parseInfo($) {
    const info = $('#info').clone();
    info.find('br').replaceWith('\n');

    const raw = Object.fromEntries(
        info
            .text()
            .split('\n')
            .flatMap((line) => {
                const normalizedLine = normalizeText(line);

                if (!normalizedLine) {
                    return [];
                }

                const separatorIndex = normalizedLine.indexOf(':');

                if (separatorIndex === -1) {
                    return [];
                }

                const key = normalizeText(normalizedLine.slice(0, separatorIndex));
                const value = normalizeText(normalizedLine.slice(separatorIndex + 1));

                return key && value ? [[key, value]] : [];
            })
    );

    return {
        raw,
        authors: splitNames(raw['作者']),
        publisher: raw['出版社'],
        producer: raw['出品方'],
        originalTitle: raw['原作名'],
        translators: splitNames(raw['译者']),
        published: raw['出版年'],
        pages: raw['页数'],
        price: raw['定价'],
        binding: raw['装帧'],
        series: raw['丛书'],
        isbn: raw.ISBN,
        links: $('#info a')
            .toArray()
            .map((element) => ({
                title: normalizeText($(element).text()),
                url: resolveUrl($(element).attr('href'), subjectBaseUrl),
            }))
            .filter((item) => item.title && item.url),
    };
}

function parseRating($) {
    const starClass = $('#interest_sectl [class*="bigstar"]')
        .attr('class')
        ?.match(/bigstar(\d+)/)?.[1];

    return {
        value: parseNumber($('#interest_sectl .rating_num').first().text()),
        max: parseNumber($('#interest_sectl [property="v:best"]').attr('content')),
        count: parseNumber($('#interest_sectl [property="v:votes"]').first().text()),
        starCount: starClass ? Number(starClass) / 10 : undefined,
        distribution: $('#interest_sectl .starstop')
            .toArray()
            .map((element) => {
                const star = $(element)
                    .attr('class')
                    ?.match(/stars(\d+)/)?.[1];

                return {
                    stars: star ? Number(star) : undefined,
                    label: normalizeText($(element).attr('title') || $(element).text()),
                    percentage: normalizeText($(element).nextAll('.rating_per').first().text()),
                };
            })
            .filter((item) => item.stars || item.percentage),
    };
}

function parseCatalog($, subjectId: string) {
    const catalog = $(`#dir_${subjectId}_full`).length ? $(`#dir_${subjectId}_full`).clone() : $(`[id^="dir_${subjectId}_"]`).first().clone();
    catalog.find('br').replaceWith('\n');
    catalog.find('a').remove();

    return catalog
        .text()
        .split('\n')
        .map((line) => normalizeText(line))
        .filter((line): line is string => Boolean(line) && !line.startsWith('·'));
}

function parseBlockquotes($, baseUrl: string) {
    return $('.blockquote-list li')
        .toArray()
        .map((element) => {
            const item = $(element);
            const figure = item.find('figure').clone();
            figure.find('.blockquote-extra').remove();

            return {
                text: normalizeText(figure.text().replace('查看原文', '')),
                url: resolveUrl(item.find('figure > a[href*="/annotation/"], figure a[href*="/annotation/"]').last().attr('href'), baseUrl),
                author: normalizeText(item.find('.author-name').text()),
                authorUrl: resolveUrl(item.find('.author-name').attr('href'), baseUrl),
                avatar: resolveUrl(item.find('.author-avatar img').attr('src'), baseUrl),
                time: normalizeText(item.find('datetime').text()),
                chapter: normalizeText(item.find('figcaption').text().replace('——', '')),
            };
        })
        .filter((item) => item.text);
}

function parseSeries($, baseUrl: string) {
    const seriesLinks = parseSeriesLinks($, baseUrl);

    return Promise.all(seriesLinks.map((series) => fetchSeries(series)));
}

function parseSeriesLinks($, baseUrl: string) {
    const seriesItems = new Map();

    for (const element of $('#info a[href*="/series/"]').toArray()) {
        const title = normalizeText($(element).text());
        const url = resolveUrl($(element).attr('href'), baseUrl);

        if (url || title) {
            seriesItems.set(url || title, { title, url });
        }
    }

    return [...seriesItems.values()];
}

function fetchSeries(series) {
    if (!series.url) {
        return {
            ...series,
            books: [],
        };
    }

    return cache.tryGet(`douban:book:series:v2:${series.url}`, async () => {
        const response = await got({
            url: series.url,
            headers: doubanHeaders,
        });
        const $ = load(response.data);
        const title = normalizeText($('h1').first().text()) || series.title;
        const books = await parseSeriesBooks($, series.url);

        return {
            ...series,
            title,
            books,
        };
    });
}

function parseSeriesBooks($, baseUrl: string) {
    const books = $('.subject-list .subject-item')
        .toArray()
        .map((element) => {
            const item = $(element);
            const titleLink = item.find('.info h2 a').first();
            const subtitle = normalizeText(titleLink.find('span').first().text().replace(':', ''));
            const url = resolveUrl(titleLink.attr('href'), baseUrl);
            const info = normalizeText(item.find('.pub').text());
            const buyInfoLink = item.find('.buy-info a').first();
            const ratingClass = item
                .find('.star [class*="allstar"]')
                .attr('class')
                ?.match(/allstar(\d+)/)?.[1];

            return {
                subjectId: url?.match(/\/subject\/(\d+)\//)?.[1],
                title: normalizeText(titleLink.attr('title') || titleLink.clone().children().remove().end().text()),
                subtitle,
                url,
                cover: resolveUrl(item.find('.pic img').attr('src'), baseUrl),
                info,
                meta: parseSeriesBookInfo(info),
                rating: {
                    value: parseNumber(item.find('.rating_nums').text()),
                    count: parseNumber(item.find('.star .pl').text()),
                    starCount: ratingClass ? Number(ratingClass) / 10 : undefined,
                    text: normalizeText(item.find('.star').text()),
                },
                summary: normalizeText(item.find('.info > p').first().text()),
                buyInfo: {
                    text: normalizeText(buyInfoLink.text()),
                    url: resolveUrl(buyInfoLink.attr('href'), baseUrl),
                    price: normalizeText(buyInfoLink.text().replace('纸质版', '')),
                },
            };
        })
        .filter((item) => item.title || item.url);

    return pMap(books, enrichSeriesBook, { concurrency: 3 });
}

async function enrichSeriesBook(book) {
    if (!book.url) {
        return book;
    }

    try {
        const detail = await fetchSeriesBookDetail(book.url);

        if (!detail?.isbn) {
            return book;
        }

        return {
            ...book,
            isbn: detail.isbn,
            meta: {
                ...book.meta,
                isbn: detail.isbn,
            },
        };
    } catch {
        return book;
    }
}

function fetchSeriesBookDetail(url: string) {
    return cache.tryGet(`douban:book:series-book:${url}`, async () => {
        const response = await got({
            url,
            headers: doubanHeaders,
        });
        const $ = load(response.data);
        const info = parseInfo($);

        return {
            isbn: info.isbn,
        };
    });
}

function parseSeriesBookInfo(info?: string) {
    if (!info) {
        return;
    }

    const [author, publisher, published, price] = info.split('/').map((item) => normalizeText(item));

    return {
        author,
        publisher,
        published,
        price,
    };
}

function parseReviews($, baseUrl: string) {
    return $('#reviews-wrapper .review-item')
        .toArray()
        .map((element) => {
            const item = $(element);
            const titleLink = item.find('.main-bd h2 a').first();
            const author = item.find('.main-hd .name').first();
            const publisher = item.find('.publisher a.publisher').first();
            const shortContent = item.find('.short-content').clone();
            shortContent.find('a.unfold').remove();

            return {
                id: normalizeText(item.attr('id')),
                title: normalizeText(titleLink.text()),
                url: resolveUrl(titleLink.attr('href'), baseUrl),
                author: normalizeText(author.text()),
                authorUrl: resolveUrl(author.attr('href'), baseUrl),
                avatar: resolveUrl(item.find('.avator img').attr('src'), baseUrl),
                rating: normalizeText(item.find('.main-title-rating').attr('title')),
                time: normalizeText(item.find('.main-meta').text()),
                publisher: normalizeText(publisher.text()),
                publisherUrl: resolveUrl(publisher.attr('href'), baseUrl),
                content: normalizeText(shortContent.text()),
                usefulCount: parseNumber(item.find('.action .up').text()),
                uselessCount: parseNumber(item.find('.action .down').text()),
                replyCount: parseNumber(item.find('.action .reply').text()),
            };
        })
        .filter((item) => item.id || item.title);
}

function getIntroText($, selector: string) {
    return normalizeMultiline($(selector).find('.all .intro').text()) || normalizeMultiline($(selector).find('.short .intro').text());
}

function getHeadingSectionText($, title: string) {
    const heading = $('h2')
        .toArray()
        .find((element) => normalizeText($(element).find('span').first().text()) === title);

    if (!heading) {
        return;
    }

    let section = $(heading).next();

    while (section.length && !normalizeText(section.text())) {
        section = section.next();
    }

    return normalizeMultiline(section.text());
}

function normalizeIsbn(value?: string) {
    const isbn = value?.replaceAll('-', '').trim();

    if (!isbn || !/^(?:\d{10}|\d{13}|\d{9}[\dXx])$/.test(isbn)) {
        return;
    }

    return isbn.toUpperCase();
}

function normalizeText(value?: string) {
    return value?.replaceAll(/\s+/g, ' ').trim() || undefined;
}

function normalizeMultiline(value?: string) {
    return (
        value
            ?.split('\n')
            .map((line) => normalizeText(line))
            .filter(Boolean)
            .join('\n') || undefined
    );
}

function splitNames(value?: string) {
    return value
        ?.split('/')
        .map((item) => normalizeText(item))
        .filter(Boolean);
}

function uniqueTexts(values: Array<string | undefined>) {
    const texts = values.map((value) => normalizeText(value)).filter(Boolean) as string[];

    return [...new Set(texts)];
}

function parseNumber(value?: string) {
    const numberText = value?.replaceAll(/[^\d.]/g, '');

    if (!numberText) {
        return;
    }

    const number = Number(numberText);

    return Number.isFinite(number) ? number : undefined;
}

function resolveUrl(value: string | undefined, baseUrl: string) {
    if (!value || value.startsWith('javascript:')) {
        return;
    }

    try {
        return new URL(value, baseUrl).href;
    } catch {
        return value;
    }
}
