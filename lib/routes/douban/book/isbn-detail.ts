import { load } from 'cheerio';

import { config } from '@/config';
import type { APIRoute } from '@/types';
import got from '@/utils/got';

const mobileBaseUrl = 'https://m.douban.com';
const subjectBaseUrl = 'https://book.douban.com/subject';

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

export const apiRoute: APIRoute = {
    path: '/book/isbnDetail/:isbn',
    maintainers: ['lyqluis'],
    parameters: {
        isbn: {
            description: 'ISBN 码，例如 `9787541161834`',
        },
    },
    description: '通过 ISBN 搜索豆瓣图书条目，并解析图书详情页返回结构化 JSON。',
    handler,
};

async function handler(ctx) {
    const isbn = normalizeIsbn(ctx.req.param('isbn'));

    if (!isbn) {
        return {
            code: 400,
            message: '请提供有效的 ISBN，支持 10 位或 13 位 ISBN。',
        };
    }

    const searchUrl = `${mobileBaseUrl}/rexxar/api/v2/search?${new URLSearchParams({
        q: isbn,
        type: '',
        loc_id: '',
        start: '0',
        count: '10',
        sort: 'relevance',
    })}`;

    const searchResponse = await got({
        url: searchUrl,
        headers: {
            Referer: mobileBaseUrl,
            'User-Agent': config.trueUA,
        },
    });
    const searchData = searchResponse.data as SearchResponse;
    const searchItem = searchData.subjects?.items?.find((item) => item.target_type === 'book' && (item.target_id || item.target?.id));
    const subjectId = searchItem?.target_id || searchItem?.target?.id;

    if (!subjectId) {
        return {
            code: 404,
            message: `未在豆瓣搜索结果中找到 ISBN ${isbn} 对应的图书条目。`,
        };
    }

    const url = `${subjectBaseUrl}/${subjectId}/`;
    const subjectResponse = await got({
        url,
        headers: {
            Referer: mobileBaseUrl,
            'User-Agent': config.trueUA,
        },
    });
    const $ = load(subjectResponse.data);

    return {
        code: 0,
        data: parseBookDetail($, isbn, subjectId, url, searchItem),
    };
}

function parseBookDetail($, isbn: string, subjectId: string, url: string, searchItem?: SearchItem) {
    const schema = parseJsonLd($);
    const info = parseInfo($);
    const bookInfo = { ...info };
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
        info: bookInfo,
        rating: parseRating($),
        summary,
        authorIntro: getHeadingSectionText($, '作者简介'),
        catalog: parseCatalog($, subjectId),
        blockquotes: parseBlockquotes($, url),
        reviews: parseReviews($, url),
    };
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
