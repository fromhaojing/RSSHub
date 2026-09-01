import { load } from 'cheerio';
import pMap from 'p-map';

import { config } from '@/config';
import type { APIRoute } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';

const mobileBaseUrl = 'https://m.douban.com';
const personageApiBaseUrl = `${mobileBaseUrl}/rexxar/api/v2/elessar`;
const doubanHeaders = {
    Referer: mobileBaseUrl,
    'User-Agent': config.trueUA,
};
const pageSize = 10;
const isbnCacheTtl = 30 * 24 * 60 * 60;

type DoubanImage = {
    url?: string;
};

type DoubanRating = {
    count?: number;
    value?: number;
};

type DoubanWork = {
    roles?: string[];
    subject?: {
        cover?: {
            large?: DoubanImage;
            normal?: DoubanImage;
        };
        extra?: {
            info?: Array<[string, string]>;
            rating_group?: {
                null_rating_reason?: string;
                rating?: DoubanRating | null;
            };
            short_info?: string;
            year?: string;
        };
        id?: string;
        title?: string;
        url?: string;
    };
};

type WorkCollection = {
    id?: string;
    title?: string;
    total?: number;
};

type PersonageResponse = {
    cover?: {
        large?: DoubanImage;
        normal?: DoubanImage;
    };
    desc?: string;
    id?: string;
    modules?: Array<{
        type?: string;
        payload?: {
            id?: string;
            collections?: WorkCollection[];
        };
    }>;
    title?: string;
    url?: string;
};

type WorksResponse = {
    total?: number;
    works?: DoubanWork[];
};

export const apiRoute: APIRoute = {
    path: '/book/authorWorks/:personageId',
    maintainers: ['lyqluis'],
    parameters: {
        personageId: {
            description: '豆瓣人物 ID，例如 `27484095`。',
        },
    },
    description: '获取豆瓣人物关联的最近图书作品。',
    handler,
};

async function handler(ctx) {
    const personageId = ctx.req.param('personageId').trim();

    if (!/^\d+$/.test(personageId)) {
        return {
            code: 0,
            message: '请提供有效的豆瓣人物 ID。',
        };
    }

    const personage = await cache.tryGet(`douban:book:personage:v1:${personageId}`, () => fetchPersonage(personageId), config.cache.contentExpire);
    const bookCollection = findBookCollection(personage);

    if (!bookCollection?.id) {
        return {
            code: 0,
            message: `${personage.title ?? personageId} 暂无可读取的图书作品。`,
        };
    }

    const page = await cache.tryGet(`douban:book:author-works:v1:${bookCollection.id}:0`, () => fetchWorks(bookCollection.id!, 0), config.cache.contentExpire);
    const total = page.total ?? bookCollection.total ?? 0;
    const works = (
        await pMap(
            page.works ?? [],
            async (work) => {
                const item = mapWork(work);

                if (!item) {
                    return;
                }

                try {
                    const result = await cache.tryGet(`douban:book:subject-isbn:v1:${item.subjectId}`, () => fetchBookIsbn(item.subjectId), isbnCacheTtl);

                    return {
                        ...item,
                        isbn: result.isbn,
                    };
                } catch {
                    return item;
                }
            },
            { concurrency: 5 }
        )
    ).filter((item) => item !== undefined);

    return {
        code: 200,
        data: {
            author: {
                id: personage.id ?? personageId,
                name: personage.title ?? personageId,
                url: personage.url ?? `${mobileBaseUrl}/personage/${personageId}/`,
                cover: personage.cover?.large?.url ?? personage.cover?.normal?.url,
                intro: personage.desc,
            },
            total,
            start: 0,
            count: works.length,
            hasMore: false,
            works,
        },
    };
}

async function fetchPersonage(personageId: string) {
    const response = await got.get(`${personageApiBaseUrl}/subject/${personageId}/`, {
        headers: doubanHeaders,
        searchParams: {
            id: personageId,
        },
    });

    return response.data as PersonageResponse;
}

async function fetchWorks(collectionId: string, start: number) {
    const response = await got.get(`${personageApiBaseUrl}/work_collections/${collectionId}/works`, {
        headers: doubanHeaders,
        searchParams: {
            id: collectionId,
            start,
            count: pageSize,
            buyable: 0,
            playable: 0,
            collection_title: '图书',
            sortby: 'time',
        },
    });

    return response.data as WorksResponse;
}

function findBookCollection(personage: PersonageResponse) {
    const payload = personage.modules?.find((module) => module.type === 'work_collections')?.payload;
    const collection = payload?.collections?.find((collection) => collection.title === '图书');

    return collection
        ? {
              ...collection,
              id: payload?.id,
          }
        : undefined;
}

function mapWork(work: DoubanWork) {
    const subject = work.subject;

    if (!subject?.id || !subject.title) {
        return;
    }

    const info = Object.fromEntries(subject.extra?.info ?? []);
    const rating = subject.extra?.rating_group?.rating;

    return {
        subjectId: subject.id,
        title: subject.title,
        cover: subject.cover?.large?.url ?? subject.cover?.normal?.url,
        author: info['作者'],
        publisher: info['出版社'],
        published: subject.extra?.year,
        shortInfo: subject.extra?.short_info,
        rating: rating?.value,
        ratingCount: rating?.count,
        roles: work.roles ?? [],
        url: subject.url ?? `https://book.douban.com/subject/${subject.id}/`,
    };
}

async function fetchBookIsbn(subjectId: string) {
    const response = await got.get(`https://book.douban.com/subject/${subjectId}/`, {
        headers: {
            ...doubanHeaders,
            Referer: 'https://book.douban.com/',
        },
    });
    const $ = load(response.data);
    const metaValue = $('meta[property="book:isbn"]').attr('content');
    const infoValue = $('#info')
        .text()
        .match(/ISBN:\s*([\dX-]+)/i)?.[1];

    return {
        isbn: normalizeIsbn(metaValue ?? infoValue),
    };
}

function normalizeIsbn(value?: string) {
    const normalized = value?.replaceAll(/[^\dX]/gi, '').toUpperCase();

    return normalized && (normalized.length === 10 || normalized.length === 13) ? normalized : undefined;
}
