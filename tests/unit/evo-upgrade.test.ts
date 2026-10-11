/**
 * ZotFlow Evo (fork): settings stored by an earlier build are brought up to
 * date when they are loaded.
 */
import { describe, expect, it } from "vitest";

import { upgradeEvoSettings } from "settings/evo-upgrade";
import {
    DEFAULT_DROP_LINK_TEMPLATE,
    DEFAULT_SETTINGS,
    PREVIOUS_DROP_LINK_TEMPLATES,
} from "settings/types";

import type { ZotFlowSettings } from "settings/types";

const settings = (patch: Partial<ZotFlowSettings>): ZotFlowSettings => ({
    ...DEFAULT_SETTINGS,
    ...patch,
});

describe("upgradeEvoSettings", () => {
    it("replaces an earlier default reference template that was stored untouched", () => {
        expect(PREVIOUS_DROP_LINK_TEMPLATES.length).toBeGreaterThan(0);
        for (const previous of PREVIOUS_DROP_LINK_TEMPLATES) {
            const s = settings({ evoDropLinkTemplate: previous });
            upgradeEvoSettings(s);
            expect(s.evoDropLinkTemplate).toBe(DEFAULT_DROP_LINK_TEMPLATE);
        }
    });

    it("leaves a template the user wrote alone, also an empty one", () => {
        for (const own of ["", "[{{ page }}]({{ link }})", PREVIOUS_DROP_LINK_TEMPLATES[0] + " "]) {
            const s = settings({ evoDropLinkTemplate: own });
            upgradeEvoSettings(s);
            expect(s.evoDropLinkTemplate).toBe(own);
        }
    });

    it("the current default is not listed as an earlier one", () => {
        expect(PREVIOUS_DROP_LINK_TEMPLATES).not.toContain(DEFAULT_DROP_LINK_TEMPLATE);
        const s = settings({});
        upgradeEvoSettings(s);
        expect(s.evoDropLinkTemplate).toBe(DEFAULT_DROP_LINK_TEMPLATE);
    });
});
