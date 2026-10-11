/**
 * ZotFlow Evo (fork): settings stored by an earlier build of the fork, brought
 * up to date when they are loaded. See FORK.md.
 */
import {
    DEFAULT_DROP_LINK_TEMPLATE,
    PREVIOUS_DROP_LINK_TEMPLATES,
} from "settings/types";

import type { ZotFlowSettings } from "settings/types";

/**
 * Change `settings` in place where an earlier default was stored. Settings
 * are saved whole, so a default that was never touched is in data.json like
 * any other value; it is recognised by being exactly an earlier default.
 */
export function upgradeEvoSettings(settings: ZotFlowSettings): void {
    if (PREVIOUS_DROP_LINK_TEMPLATES.includes(settings.evoDropLinkTemplate)) {
        settings.evoDropLinkTemplate = DEFAULT_DROP_LINK_TEMPLATE;
    }
}
