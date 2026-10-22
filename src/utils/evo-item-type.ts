/**
 * ZotFlow Evo (fork): an item turned into another item type, as Zotero's
 * own client does it: each field goes to the field the new type has for the
 * same base field (a journal's "Publication" becomes a book section's "Book
 * title"); fields the new type does not have are dropped (and named, so the
 * editor can ask first); creators of a type the new item type does not
 * take become its main creator type. Pure.
 */
import { BASE_FIELD_MAP, ZOTERO_FIELDS } from "types/zotero-base-fields";
import { ITEM_TYPE_CREATORS, ITEM_TYPE_FIELDS } from "types/zotero-csl-schema";

const FIELD_NAMES = new Set<string>(ZOTERO_FIELDS);

/** The base field a type's field stands for (itself, if none). */
function baseOf(itemType: string, field: string): string {
    const map = BASE_FIELD_MAP[itemType] ?? {};
    for (const [base, specific] of Object.entries(map))
        if (specific === field) return base;
    return field;
}

/** The field of `itemType` for a base field, if it has one. */
function fieldFor(itemType: string, base: string): string | null {
    const specific = BASE_FIELD_MAP[itemType]?.[base];
    const fields = ITEM_TYPE_FIELDS[itemType] ?? [];
    if (specific && fields.includes(specific)) return specific;
    return fields.includes(base) ? base : null;
}

export interface TypeChange {
    data: Record<string, unknown>;
    /** Fields with a value the new type has no place for. */
    dropped: { field: string; value: string }[];
}

export function changeItemType(
    data: Record<string, unknown>,
    newType: string,
): TypeChange {
    const oldType = typeof data.itemType === "string" ? data.itemType : "";
    const out: Record<string, unknown> = {};
    const dropped: { field: string; value: string }[] = [];
    for (const [name, value] of Object.entries(data)) {
        if (!FIELD_NAMES.has(name)) {
            out[name] = value;
            continue;
        }
        if (value === "" || value === null || value === undefined) continue;
        const target = fieldFor(newType, baseOf(oldType, name));
        if (target) out[target] = value;
        else
            dropped.push({
                field: name,
                value:
                    typeof value === "string" ? value : JSON.stringify(value),
            });
    }
    out.itemType = newType;
    const takes = ITEM_TYPE_CREATORS[newType] ?? [];
    const primary = takes[0] ?? "author";
    if (Array.isArray(data.creators)) {
        out.creators = (data.creators as { creatorType?: string }[]).map((c) =>
            c.creatorType && takes.includes(c.creatorType)
                ? c
                : {
                      ...c,
                      creatorType:
                          c.creatorType ===
                              (ITEM_TYPE_CREATORS[oldType] ?? [])[0] ||
                          !takes.includes("contributor")
                              ? primary
                              : "contributor",
                  },
        );
    }
    return { data: out, dropped };
}
