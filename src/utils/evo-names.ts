/**
 * ZotFlow Evo (fork): a creator's name as one string, both ways. Zotero
 * keeps a last and a first name; the editor shows one field:
 *
 * - The last word is the last name, with the particles right before it
 *   (van, von, de, der, …: "Jan van der Berg" → "van der Berg", "Jan";
 *   capitalised ones too, as in "Martin Van Buren", as long as a first name
 *   is left). Zotero's citation processor treats a lowercase particle at
 *   the start of a last name as one, so styles still sort under "Berg".
 * - A comma splits by hand: "García Márquez, Gabriel", "La Fontaine, Jean de".
 * - "Jr.", "Sr.", "II", "III", "IV" at the end are a suffix, kept with the
 *   first name as Zotero expects ("Martin Luther, Jr.").
 * - One word is a last name alone. A name in braces ("{Deutsche Bahn AG}")
 *   is one field (an institution); so is one that was one field before.
 *
 * Library standards (RDA F.11) file particles by the language of the name,
 * which a string does not tell; this rule keeps them with the last name and
 * leaves sorting to the citation style. See FORK.md.
 */

export interface TwoFieldName {
    firstName: string;
    lastName: string;
}

export interface OneFieldName {
    name: string;
}

export type CreatorName = TwoFieldName | OneFieldName;

const PARTICLES = new Set([
    "van",
    "von",
    "der",
    "den",
    "de",
    "du",
    "des",
    "la",
    "le",
    "di",
    "da",
    "dos",
    "das",
    "del",
    "della",
    "dello",
    "ten",
    "ter",
    "zu",
    "zur",
    "zum",
    "vom",
    "y",
    "e",
    "het",
    "'t",
    "op",
    "in",
    "af",
    "av",
    "al",
    "el",
    "bin",
    "ibn",
]);

/** Particles that count capitalised too ("Martin Van Buren", "Robert De Niro"). */
const CAPITALISED = new Set([
    "van", "von", "der", "den", "de", "du", "des", "la", "le", "di", "da",
    "dos", "das", "del", "della", "dello", "ten", "ter", "zu", "zur", "zum",
    "vom",
]);

const isParticle = (word: string) =>
    PARTICLES.has(word) ||
    (/^\p{Lu}/u.test(word) && CAPITALISED.has(word.toLowerCase()));

const SUFFIX = /^(?:jr\.?|sr\.?|ii|iii|iv)$/i;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** One string → a Zotero name. Null for an empty string. */
export function parseCreatorName(
    input: string,
    opts: { singleField?: boolean } = {},
): CreatorName | null {
    let text = clean(input);
    if (!text) return null;
    const braced = /^\{(.+)\}$/.exec(text);
    if (braced) return { name: clean(braced[1]!) };
    if (opts.singleField && !text.includes(",")) return { name: text };

    // A suffix after the last comma ("…, Jr.") is not "Last, First".
    let suffix = "";
    const tail = /,\s*([^,]+)$/.exec(text);
    if (tail && SUFFIX.test(tail[1]!.trim())) {
        suffix = tail[1]!.trim();
        text = clean(text.slice(0, tail.index));
    }
    const withSuffix = (first: string) =>
        suffix ? (first ? `${first}, ${suffix}` : suffix) : first;

    const comma = text.indexOf(",");
    if (comma >= 0) {
        const last = clean(text.slice(0, comma));
        const first = clean(text.slice(comma + 1));
        if (last) return { lastName: last, firstName: withSuffix(first) };
        text = first;
    }

    const words = text.split(" ");
    if (!suffix && words.length > 2 && SUFFIX.test(words[words.length - 1]!)) {
        suffix = words.pop()!;
    }
    if (words.length === 1) {
        return { lastName: words[0]!, firstName: withSuffix("") };
    }
    let start = words.length - 1;
    while (start > 1 && isParticle(words[start - 1]!)) start--;
    // "de Gaulle" alone: the particle stays with the name.
    if (start === 1 && PARTICLES.has(words[0]!)) start = 0;
    return {
        lastName: words.slice(start).join(" "),
        firstName: withSuffix(words.slice(0, start).join(" ")),
    };
}

/** A name in natural order: "Jan van der Berg", "Martin Luther King, Jr.". */
export function naturalName(c: CreatorName): string {
    if ("name" in c) return clean(c.name);
    const first = clean(c.firstName ?? "");
    const last = clean(c.lastName ?? "");
    const m = /^(.*?),\s*([^,]+)$/.exec(first);
    if (m && SUFFIX.test(m[2]!.trim())) {
        return clean(`${m[1]} ${last}`) + `, ${m[2]!.trim()}`;
    }
    return clean(`${first} ${last}`);
}

/**
 * The name as the editor shows it: in natural order where reading it back
 * gives the same name, else "Last, First" (which always does).
 */
export function editableName(c: CreatorName): string {
    if ("name" in c) return clean(c.name);
    const natural = naturalName(c);
    const back = parseCreatorName(natural);
    if (
        back &&
        "lastName" in back &&
        back.lastName === clean(c.lastName ?? "") &&
        back.firstName === clean(c.firstName ?? "")
    ) {
        return natural;
    }
    const first = clean(c.firstName ?? "");
    return first ? `${clean(c.lastName ?? "")}, ${first}` : clean(c.lastName ?? "");
}
