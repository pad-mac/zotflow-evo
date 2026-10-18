// scripts/generate-types-from-file.ts
import * as fs from "fs";
import * as path from "path";
import { format, resolveConfig } from "prettier";

const __dirname = path.resolve();

// Zotero Schema URL
const SCHEMA_URL = "https://api.zotero.org/schema";

const SCHEMA_PATH = path.join(__dirname, "./schema.json");

/**
 * Generation reads the committed schema.json so output is reproducible.
 * Pass --fetch to refresh schema.json from the Zotero API first.
 * Usage: npm run generate-zotero-item-schema [-- --fetch]
 */
async function loadSchema() {
    if (process.argv.includes("--fetch")) {
        const response = await fetch(SCHEMA_URL);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch schema: ${response.status} ${response.statusText}`,
            );
        }
        const schema = await response.json();
        // Localized labels make up most of the payload: keep only the
        // English item type names (the UI's display names).
        const labels = schema.locales?.["en-US"]?.itemTypes ?? {};
        schema.locales = { "en-US": { itemTypes: labels } };
        fs.writeFileSync(
            SCHEMA_PATH,
            JSON.stringify(schema, null, "\t") + "\n",
        );
        console.log(`Fetched Zotero schema v${schema.version}`);
        return schema;
    }
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

async function generate() {
    const schema = await loadSchema();

    let output = `
/**
 * AUTO-GENERATED ZOTERO TYPES
 * Source: schema.json (v${schema.version})
 */

interface BaseZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  parentItem?: string;
  title?: string;
  collections?: string[];
  dateAdded: string;
  dateModified: string;
  tags: Array<{ tag: string; type?: number }>;
  relations: { [key: string]: string | string[] };
  deleted: boolean;
}
`;

    const typeNames = [];
    const itemTypes = [];
    const primaryCreatorTypes = {};
    // itemType → baseField → type-specific field (e.g. case.title → caseName)
    const baseFieldMap = {};
    // Every field name any item type uses, plus base names (e.g. `authority`)
    // that only exist as a mapping target.
    const allFields = new Set();

    // Iterate over schema.itemTypes
    for (const typeDef of schema.itemTypes) {
        const itemType = typeDef.itemType;
        itemTypes.push(itemType);
        const interfaceName = pascalCase(itemType);
        typeNames.push(interfaceName);

        console.log(`Generating ${interfaceName}...`);

        let fieldsStr = "";

        // Process unique fields for this type
        for (const fieldObj of typeDef.fields) {
            const fieldName = fieldObj.field;
            allFields.add(fieldName);
            if (fieldObj.baseField) {
                allFields.add(fieldObj.baseField);
                baseFieldMap[itemType] ??= {};
                baseFieldMap[itemType][fieldObj.baseField] = fieldName;
            }
            const fieldType = "string"; // Default to string
            fieldsStr += `    ${fieldName}?: ${fieldType};\n`;
        }

        // Process creators
        if (typeDef.creatorTypes && typeDef.creatorTypes.length > 0) {
            const creatorTypeUnion = typeDef.creatorTypes
                .map((c) => `'${c.creatorType}'`)
                .join(" | ");

            fieldsStr += `    creators?: Array<{ creatorType: ${creatorTypeUnion}; firstName?: string; lastName?: string; name?: string; }>;\n`;

            // Find primary creator type
            const primary = typeDef.creatorTypes.find((c) => c.primary);
            if (primary) {
                primaryCreatorTypes[itemType] = primary.creatorType;
            }
        }

        // Generate Interface
        output += `
interface ${interfaceName}Data extends BaseZoteroItemData {
  itemType: '${itemType}';
  ${fieldsStr}
}
`;
    }

    // Generate Primary Creator Type Map
    output += `\n\nexport interface ZoteroPrimaryCreatorTypes {\n`;
    for (const [type, creator] of Object.entries(primaryCreatorTypes)) {
        output += `  ${type}: '${creator}';\n`;
    }
    output += `}\n`;

    // Generate Union Type
    output += `\nexport type ZoteroItemData = ${typeNames.map((t) => t + "Data").join(" | ")};\n`;

    // Generate Item Type Union & Guard
    output += `\nexport interface ZoteroItemDataTypeMap {
    ${itemTypes.map((t) => `'${t}': ${pascalCase(t)}Data`).join(" ;\n")}
  }\n`;

    const typesPath = path.join(__dirname, "./src/types/zotero-item.d.ts");
    const constPath = path.join(__dirname, "./src/types/zotero-item-const.ts");
    const baseFieldsPath = path.join(
        __dirname,
        "./src/types/zotero-base-fields.ts",
    );
    const labelsPath = path.join(
        __dirname,
        "./src/types/zotero-item-type-labels.ts",
    );
    const itemTypeLabels = schema.locales?.["en-US"]?.itemTypes ?? {};
    if (Object.keys(itemTypeLabels).length === 0) {
        console.warn(
            "schema.json has no item type labels; run with --fetch to add them.",
        );
    }

    const prettierOptions = {
        ...(await resolveConfig(typesPath, { editorconfig: true })),
        parser: "typescript",
    };

    fs.writeFileSync(typesPath, await format(output, prettierOptions));

    fs.writeFileSync(
        constPath,
        await format(
            `\nexport const Zotero_Item_Types: string[] = [${itemTypes.map((t) => `'${t}'`).join(",")}];\n`,
            prettierOptions,
        ),
    );

    fs.writeFileSync(
        baseFieldsPath,
        await format(
            `/**
 * AUTO-GENERATED by scripts/generate-zotero-item-schema.js — do not edit.
 * Source: Zotero schema v${schema.version}
 *
 * Maps each item type's base fields to the type-specific field that
 * stands in for them (e.g. a case's \`title\` lives in \`caseName\`).
 * Read fields through \`getField()\` in \`utils/zotero-fields\`.
 */
export const ZOTERO_SCHEMA_VERSION = ${schema.version};

export const BASE_FIELD_MAP: Readonly<
    Record<string, Readonly<Record<string, string>>>
> = ${JSON.stringify(baseFieldMap)};

/** Every item field name in the schema, base names included. */
export const ZOTERO_FIELDS = ${JSON.stringify([...allFields].sort())} as const;

export type ZoteroFieldName = (typeof ZOTERO_FIELDS)[number];
`,
            prettierOptions,
        ),
    );

    // ZotFlow Evo: what a new item read as CSL-JSON (a DOI looked up) may
    // hold, per item type, and how CSL names map to Zotero's.
    const typeFields = {};
    const typeCreators = {};
    for (const typeDef of schema.itemTypes) {
        typeFields[typeDef.itemType] = typeDef.fields.map((f) => f.field);
        const creators = (typeDef.creatorTypes ?? []).map((c) => c.creatorType);
        const primary = (typeDef.creatorTypes ?? []).find((c) => c.primary);
        typeCreators[typeDef.itemType] = primary
            ? [primary.creatorType, ...creators.filter((c) => c !== primary.creatorType)]
            : creators;
    }
    const csl = schema.csl ?? { types: {}, fields: { text: {}, date: {} }, names: {} };
    const cslTypes = Object.fromEntries(
        Object.entries(csl.types).map(([cslType, types]) => [cslType, types[0]]),
    );
    const cslNames = {};
    for (const [zoteroType, cslName] of Object.entries(csl.names)) {
        cslNames[cslName] ??= zoteroType;
    }
    fs.writeFileSync(
        path.join(__dirname, "./src/types/zotero-csl-schema.ts"),
        await format(
            `/**
 * AUTO-GENERATED by scripts/generate-zotero-item-schema.js — do not edit.
 * Source: Zotero schema v${schema.version}
 *
 * ZotFlow Evo: the fields and creator types each item type takes (primary
 * creator type first), and Zotero's mapping from CSL-JSON (types, text and
 * date variables to base fields, names to creator types). Used to make an
 * item from a DOI (utils/evo-identifier.ts).
 */
export const ITEM_TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(typeFields)};

export const ITEM_TYPE_CREATORS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(typeCreators)};

export const CSL_TYPES: Readonly<Record<string, string>> = ${JSON.stringify(cslTypes)};

export const CSL_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(csl.fields.text)};

export const CSL_DATE_FIELDS: Readonly<Record<string, string>> = ${JSON.stringify(csl.fields.date)};

export const CSL_NAME_TYPES: Readonly<Record<string, string>> = ${JSON.stringify(cslNames)};
`,
            prettierOptions,
        ),
    );

    fs.writeFileSync(
        labelsPath,
        await format(
            `/**
 * AUTO-GENERATED by scripts/generate-zotero-item-schema.js — do not edit.
 * Source: Zotero schema v${schema.version} (locales.en-US.itemTypes)
 *
 * Zotero's display name of each item type (e.g. conferencePaper →
 * "Conference Paper"). Read through \`itemTypeLabel()\`.
 */
export const ITEM_TYPE_LABELS: Readonly<Record<string, string>> = ${JSON.stringify(itemTypeLabels)};

/** Zotero's display name of an item type; the type itself when it has none. */
export function itemTypeLabel(itemType: string): string {
    return ITEM_TYPE_LABELS[itemType] ?? itemType;
}
`,
            prettierOptions,
        ),
    );

    console.log("✅ Types generated!");
}

function pascalCase(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

generate();
