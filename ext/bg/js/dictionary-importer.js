/*
 * Copyright (C) 2020  Alex Yatskov <alex@foosoft.net>
 * Author: Alex Yatskov <alex@foosoft.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* global
 * JSZip
 * JsonSchema
 * requestJson
 */

class DictionaryImporter {
    constructor() {
        this._schemas = new Map();
    }

    async import(database, archiveSource, onProgress, details) {
        if (!database) {
            throw new Error('Invalid database');
        }
        if (!database.isPrepared()) {
            throw new Error('Database is not ready');
        }

        const hasOnProgress = (typeof onProgress === 'function');

        // Read archive
        const archive = await JSZip.loadAsync(archiveSource);

        // Read and validate index
        const indexFileName = 'index.json';
        const indexFile = archive.files[indexFileName];
        if (!indexFile) {
            throw new Error('No dictionary index found in archive');
        }

        const index = JSON.parse(await indexFile.async('string'));

        const indexSchema = await this._getSchema('/bg/data/dictionary-index-schema.json');
        this._validateJsonSchema(index, indexSchema, indexFileName);

        const dictionaryTitle = index.title;
        const version = index.format || index.version;

        if (!dictionaryTitle || !index.revision) {
            throw new Error('Unrecognized dictionary format');
        }

        // Verify database is not already imported
        if (await database.dictionaryExists(dictionaryTitle)) {
            throw new Error('Dictionary is already imported');
        }

        // Data format converters
        const convertTermBankEntry = (entry) => {
            if (version === 1) {
                const [expression, reading, definitionTags, rules, score, ...glossary] = entry;
                return {expression, reading, definitionTags, rules, score, glossary};
            } else {
                const [expression, reading, definitionTags, rules, score, glossary, sequence, termTags] = entry;
                return {expression, reading, definitionTags, rules, score, glossary, sequence, termTags};
            }
        };

        const convertTermMetaBankEntry = (entry) => {
            const [expression, mode, data] = entry;
            return {expression, mode, data};
        };

        const convertKanjiBankEntry = (entry) => {
            if (version === 1) {
                const [character, onyomi, kunyomi, tags, ...meanings] = entry;
                return {character, onyomi, kunyomi, tags, meanings};
            } else {
                const [character, onyomi, kunyomi, tags, meanings, stats] = entry;
                return {character, onyomi, kunyomi, tags, meanings, stats};
            }
        };

        const convertKanjiMetaBankEntry = (entry) => {
            const [character, mode, data] = entry;
            return {character, mode, data};
        };

        const convertTagBankEntry = (entry) => {
            const [name, category, order, notes, score] = entry;
            return {name, category, order, notes, score};
        };

        // Archive file reading
        const readFileSequence = async (fileNameFormat, convertEntry, schema) => {
            const results = [];
            for (let i = 1; true; ++i) {
                const fileName = fileNameFormat.replace(/\?/, `${i}`);
                const file = archive.files[fileName];
                if (!file) { break; }

                const entries = JSON.parse(await file.async('string'));
                this._validateJsonSchema(entries, schema, fileName);

                for (let entry of entries) {
                    entry = convertEntry(entry);
                    entry.dictionary = dictionaryTitle;
                    results.push(entry);
                }
            }
            return results;
        };

        // Load schemas
        const dataBankSchemaPaths = this._getDataBankSchemaPaths(version);
        const dataBankSchemas = await Promise.all(dataBankSchemaPaths.map((path) => this._getSchema(path)));

        // Load data
        const termList      = await readFileSequence('term_bank_?.json',       convertTermBankEntry,      dataBankSchemas[0]);
        const termMetaList  = await readFileSequence('term_meta_bank_?.json',  convertTermMetaBankEntry,  dataBankSchemas[1]);
        const kanjiList     = await readFileSequence('kanji_bank_?.json',      convertKanjiBankEntry,     dataBankSchemas[2]);
        const kanjiMetaList = await readFileSequence('kanji_meta_bank_?.json', convertKanjiMetaBankEntry, dataBankSchemas[3]);
        const tagList       = await readFileSequence('tag_bank_?.json',        convertTagBankEntry,       dataBankSchemas[4]);

        // Old tags
        const indexTagMeta = index.tagMeta;
        if (typeof indexTagMeta === 'object' && indexTagMeta !== null) {
            for (const name of Object.keys(indexTagMeta)) {
                const {category, order, notes, score} = indexTagMeta[name];
                tagList.push({name, category, order, notes, score});
            }
        }

        // Prefix wildcard support
        const prefixWildcardsSupported = !!details.prefixWildcardsSupported;
        if (prefixWildcardsSupported) {
            for (const entry of termList) {
                entry.expressionReverse = stringReverse(entry.expression);
                entry.readingReverse = stringReverse(entry.reading);
            }
        }

        // Add dictionary
        const summary = {
            title: dictionaryTitle,
            revision: index.revision,
            sequenced: index.sequenced,
            version,
            prefixWildcardsSupported
        };

        database.bulkAdd('dictionaries', [summary], 0, 1);

        // Add data
        const errors = [];
        const total = (
            termList.length +
            termMetaList.length +
            kanjiList.length +
            kanjiMetaList.length +
            tagList.length
        );
        let loadedCount = 0;
        const maxTransactionLength = 1000;

        const bulkAdd = async (objectStoreName, entries) => {
            const ii = entries.length;
            for (let i = 0; i < ii; i += maxTransactionLength) {
                const count = Math.min(maxTransactionLength, ii - i);

                try {
                    await database.bulkAdd(objectStoreName, entries, i, count);
                } catch (e) {
                    errors.push(e);
                }

                loadedCount += count;
                if (hasOnProgress) {
                    onProgress(total, loadedCount);
                }
            }
        };

        await bulkAdd('terms', termList);
        await bulkAdd('termMeta', termMetaList);
        await bulkAdd('kanji', kanjiList);
        await bulkAdd('kanjiMeta', kanjiMetaList);
        await bulkAdd('tagMeta', tagList);

        return {result: summary, errors};
    }

    async _getSchema(fileName) {
        let schemaPromise = this._schemas.get(fileName);
        if (typeof schemaPromise !== 'undefined') {
            return schemaPromise;
        }

        schemaPromise = requestJson(chrome.runtime.getURL(fileName), 'GET');
        this._schemas.set(fileName, schemaPromise);
        return schemaPromise;
    }

    _validateJsonSchema(value, schema, fileName) {
        try {
            JsonSchema.validate(value, schema);
        } catch (e) {
            throw this._formatSchemaError(e, fileName);
        }
    }

    _formatSchemaError(e, fileName) {
        const valuePathString = this._getSchemaErrorPathString(e.info.valuePath, 'dictionary');
        const schemaPathString = this._getSchemaErrorPathString(e.info.schemaPath, 'schema');

        const e2 = new Error(`Dictionary has invalid data in '${fileName}' for value '${valuePathString}', validated against '${schemaPathString}': ${e.message}`);
        e2.data = e;

        return e2;
    }

    _getSchemaErrorPathString(infoList, base='') {
        let result = base;
        for (const [part] of infoList) {
            switch (typeof part) {
                case 'string':
                    if (result.length > 0) {
                        result += '.';
                    }
                    result += part;
                    break;
                case 'number':
                    result += `[${part}]`;
                    break;
            }
        }
        return result;
    }

    _getDataBankSchemaPaths(version) {
        const termBank = (
            version === 1 ?
            '/bg/data/dictionary-term-bank-v1-schema.json' :
            '/bg/data/dictionary-term-bank-v3-schema.json'
        );
        const termMetaBank = '/bg/data/dictionary-term-meta-bank-v3-schema.json';
        const kanjiBank = (
            version === 1 ?
            '/bg/data/dictionary-kanji-bank-v1-schema.json' :
            '/bg/data/dictionary-kanji-bank-v3-schema.json'
        );
        const kanjiMetaBank = '/bg/data/dictionary-kanji-meta-bank-v3-schema.json';
        const tagBank = '/bg/data/dictionary-tag-bank-v3-schema.json';

        return [termBank, termMetaBank, kanjiBank, kanjiMetaBank, tagBank];
    }
}
