// LEGACY SHIM — the old shared UI helpers now delegate entirely to the Design
// System v1 kit (src/design/primitives, docs/design-system.md). 37 call sites
// keep importing from here; new code imports the primitives directly.
//
// td is intentionally the COMPACT density (founder profile: comfortable
// surfaces, compact data tables) with no text color — cells keep their own.
export { InHubContextV2 as InHubContext, PageHeaderV2 as PageHeader, TH as th } from '../design/primitives';
export const td = 'py-2 px-3';
