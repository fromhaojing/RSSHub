import { convert } from 'html-to-text';

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

type PersonageResponse = {
    cover?: {
        large?: { url?: string };
        normal?: { url?: string };
    };
    desc?: string;
    id?: string;
    modules?: Array<{
        type?: string;
        payload?: {
            collections?: Array<{
                title?: string;
                total?: number;
            }>;
        };
    }>;
    title?: string;
    url?: string;
};

export const apiRoute: APIRoute = {
    path: '/book/authorProfile/:personageId',
    maintainers: ['lyqluis'],
    parameters: {
        personageId: {
            description: '豆瓣人物 ID，例如 `27484095`。',
        },
    },
    description: '获取豆瓣人物的作者资料、头像和图书作品总数。',
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

    const personage = await cache.tryGet(`douban:book:author-profile:v2:${personageId}`, () => fetchPersonage(personageId), config.cache.contentExpire);

    return {
        code: 200,
        data: {
            id: personage.id ?? personageId,
            name: personage.title ?? personageId,
            avatar: personage.cover?.large?.url ?? personage.cover?.normal?.url,
            url: personage.url ?? `${mobileBaseUrl}/personage/${personageId}/`,
            intro: toPlainText(personage.desc),
            worksCount: getBookWorksCount(personage),
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

function getBookWorksCount(personage: PersonageResponse) {
    return personage.modules?.find((module) => module.type === 'work_collections')?.payload?.collections?.find((collection) => collection.title === '图书')?.total;
}

function toPlainText(value?: string) {
    if (!value) {
        return;
    }

    return convert(value, {
        wordwrap: false,
        selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' },
        ],
    })
        .replaceAll(/\n{3,}/g, '\n\n')
        .trim();
}
