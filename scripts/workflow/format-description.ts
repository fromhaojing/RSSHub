import fs from 'node:fs/promises';
import path from 'node:path';

import stringWidth from 'fast-string-width';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkPangu from 'remark-pangu';
import typescript from 'typescript';

const __dirname = import.meta.dirname;
const routesDir = path.resolve(__dirname, '../../lib/routes');

function remarkDirectiveSpace() {
    return (tree: any) => {
        walkDirectiveAst(tree);
    };
}

function walkDirectiveAst(node: any): void {
    if (node.type === 'text' && typeof node.value === 'string') {
        node.value = node.value.replaceAll(/^:::([A-Za-z][\w-]*)/gm, '::: $1');
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            walkDirectiveAst(child);
        }
    }
}

const processor = remark()
    .data('settings', {
        bullet: '-',
    })
    .use(remarkDirectiveSpace)
    .use(remarkPangu)
    .use(remarkGfm, {
        stringLength: stringWidth,
    });

interface DescriptionEdit {
    start: number;
    end: number;
    raw: string;
}

function getPropertyName(name: typescript.PropertyName): string {
    if (typescript.isIdentifier(name) || typescript.isPrivateIdentifier(name) || typescript.isStringLiteral(name) || typescript.isNoSubstitutionTemplateLiteral(name)) {
        return name.text;
    }
    return '';
}

const TARGETS: Record<string, string> = { route: 'Route', namespace: 'Namespace' };

function isTargetTypedDeclaration(decl: typescript.VariableDeclaration): boolean {
    if (!typescript.isIdentifier(decl.name)) {
        return false;
    }
    const expectedType = TARGETS[decl.name.text];
    if (!expectedType) {
        return false;
    }
    if (decl.type && typescript.isTypeReferenceNode(decl.type)) {
        const typeName = decl.type.typeName;
        if (typescript.isIdentifier(typeName) && typeName.text === expectedType) {
            return true;
        }
    }
    return false;
}

function collectDescriptionEdits(sourceFile: typescript.SourceFile): DescriptionEdit[] {
    const edits: DescriptionEdit[] = [];

    const visitObject = (obj: typescript.ObjectLiteralExpression) => {
        for (const prop of obj.properties) {
            if (!typescript.isPropertyAssignment(prop)) {
                continue;
            }
            const name = getPropertyName(prop.name);
            if (name === 'description') {
                const init = prop.initializer;
                if (typescript.isStringLiteral(init) || typescript.isNoSubstitutionTemplateLiteral(init)) {
                    edits.push({
                        start: init.getStart(sourceFile),
                        end: init.getEnd(),
                        raw: init.text,
                    });
                }
            } else if ((name === 'ja' || name === 'zh' || name === 'zh-TW') && typescript.isObjectLiteralExpression(prop.initializer)) {
                visitObject(prop.initializer);
            }
        }
    };

    for (const stmt of sourceFile.statements) {
        if (!typescript.isVariableStatement(stmt)) {
            continue;
        }
        const isExported = stmt.modifiers?.some((m) => m.kind === typescript.SyntaxKind.ExportKeyword);
        if (!isExported) {
            continue;
        }
        for (const decl of stmt.declarationList.declarations) {
            if (!isTargetTypedDeclaration(decl)) {
                continue;
            }
            if (decl.initializer && typescript.isObjectLiteralExpression(decl.initializer)) {
                visitObject(decl.initializer);
            }
        }
    }

    return edits;
}

function escapeTemplateLiteral(s: string): string {
    return s
        .replaceAll('\\', String.raw`\\`)
        .replaceAll('`', '\\`')
        .replaceAll('${', '\\${');
}

async function* walk(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            yield full;
        }
    }
}

async function processFile(filePath: string): Promise<void> {
    const sourceText = await fs.readFile(filePath, 'utf8');
    if (!sourceText.includes('description')) {
        return;
    }

    const sourceFile = typescript.createSourceFile(filePath, sourceText, typescript.ScriptTarget.Latest, false, filePath.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS);

    const edits = collectDescriptionEdits(sourceFile);
    if (edits.length === 0) {
        return;
    }

    edits.sort((a, b) => b.start - a.start);

    let result = sourceText;
    let changed = false;

    const formattedResults = await Promise.all(
        edits.map(async (edit) => {
            if (!edit.raw.trim()) {
                return { edit, formatted: null as string | null };
            }
            const file = await processor.process(edit.raw);
            return {
                edit,
                formatted: String(file).replace(/\n+$/, ''),
            };
        })
    );

    for (const { edit, formatted } of formattedResults) {
        if (!formatted || formatted === edit.raw) {
            continue;
        }

        const replacement = '`' + escapeTemplateLiteral(formatted) + '`'; // oxlint handles unncessary single line template literals.
        result = result.slice(0, edit.start) + replacement + result.slice(edit.end);
        changed = true;
    }

    if (changed) {
        await fs.writeFile(filePath, result, 'utf8');
    }
}

async function main() {
    const started = performance.now();
    // @ts-ignore ts(2550)
    const files: string[] = await Array.fromAsync(walk(routesDir));

    await Promise.all(files.map((f) => processFile(f)));

    // oxlint-disable-next-line no-console
    console.log(`Finished in ${Math.round(performance.now() - started)}ms on ${files.length} files.`);
}

await main();
