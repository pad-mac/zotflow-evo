/**
 * ZotFlow Evo (fork): the item last selected in a library browser or a
 * collection tab. The item details tab shows it, and "save to the selected
 * item" (Anna's Archive) saves to it. See FORK.md.
 */
import { EventBus } from "services/event-bus";
import { plainTitle } from "utils/evo-library-model";

export interface SelectedItem {
    libraryID: number;
    key: string;
    /** As shown in menus: "Schmidgen 2005 Lebendige Kräfte". */
    label: string;
    itemType?: string;
}

let last: SelectedItem | null = null;
const bus = new EventBus<[SelectedItem]>();

/** A table's focused item changed. */
export function publishSelection(item: SelectedItem): void {
    if (
        last &&
        last.libraryID === item.libraryID &&
        last.key === item.key &&
        last.label === item.label
    )
        return;
    last = item;
    bus.emit(item);
}

export function lastSelection(): SelectedItem | null {
    return last;
}

export function onSelection(
    listener: (item: SelectedItem) => void,
): () => void {
    return bus.subscribe(listener);
}

/** The label of a row in menus and notices: "Schmidgen 2005 Lebendige Kräfte". */
export function selectionLabel(row: {
    firstCreator: string;
    year: string;
    title: string;
}): string {
    return [row.firstCreator, row.year, plainTitle(row.title)]
        .filter(Boolean)
        .join(" ");
}

/** The library or collection shown last in a library tab (where new items go). */
export interface ShownScope {
    libraryID: number;
    collectionKey: string | null;
    /** Its name. */
    label: string;
}

let lastShown: ShownScope | null = null;

export function publishScope(scope: ShownScope): void {
    lastShown = scope;
}

export function lastScope(): ShownScope | null {
    return lastShown;
}
