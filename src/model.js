// The neutral library model shared by the reader (src/format/) and the writers (src/export/).
// The reader produces it from a Garmin BaseCamp library; the writers never see raw bytes.
// Every coordinate is WGS84 decimal degrees; every time is a JS millisecond epoch (UTC) or null.

/**
 * @typedef {object} Point
 * @property {number} lat         decimal degrees, -90..90
 * @property {number} lon         decimal degrees, -180..180
 * @property {number|null} ele    metres, or null when absent
 * @property {number|null} time   ms since 1970-01-01 UTC, or null when absent
 * @property {number|null} [hr]     track points only: heart rate in beats per minute, an integer 1-255, when the library
 *                                  holds one for this point (TrackSegments slot 7, FORMAT.md §15.7; decision B44).
 *                                  Absent (or null) otherwise: a reader sets it only where there is a value.
 * @property {number|null} [atemp]  track points only: air temperature in degrees Celsius, when the library holds one
 *                                  for this point (TrackSegments slot 6, FORMAT.md §15.7; B44). Absent (or null)
 *                                  otherwise.
 */

/**
 * @typedef {object} Waypoint
 * @property {"waypoint"} kind
 * @property {string} id          stable id inside this library (reader-defined, unique across all items)
 * @property {string} name
 * @property {string} comment     "" when absent
 * @property {string} symbol      Garmin symbol name ("" when unknown)
 * @property {number|null} icon   the raw icon number from the library (null when unknown); not exported, kept for the report
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} ele
 * @property {number|null} time
 */

/**
 * @typedef {object} Track
 * @property {"track"} kind
 * @property {string} id
 * @property {string} name
 * @property {string} comment
 * @property {string|null} color   GPX/Garmin colour name or null
 * @property {number|null} colorIndex  the raw colour index from the library (null when unknown)
 * @property {boolean} [sensorData]  whether any point may carry `hr` or `atemp` (B44). The reader sets it on every
 *   track, so a writer can decide what its file header declares without building the points; when it is absent, a
 *   writer looks at the points.
 * @property {Point[][]} segments  one array of points per segment (a segment may be empty).
 *   It may be an accessor (a getter) that builds FRESH arrays and Point objects on every read: the reader
 *   (src/format/library.js, packedTrack) keeps positions packed in typed arrays to save memory and builds
 *   points only when asked. So read it once into a local variable and loop over that; never mutate the result
 *   expecting the track to change, never compare two reads by identity, and use trackShape() (library.js) for
 *   counts without building the points.
 */

/**
 * @typedef {object} RoutePoint
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} ele
 * @property {string} name        "" when the route point is not a named waypoint
 * @property {string} symbol
 */

/**
 * @typedef {object} Route
 * @property {"route"} kind
 * @property {string} id
 * @property {string} name
 * @property {string} comment
 * @property {RoutePoint[]} points  the via points in order (autorouted shaping is not exported)
 */

/** @typedef {Waypoint|Track|Route} Item */

/**
 * A folder or a list. BaseCamp lets an item appear in several lists; a folder holds lists and folders.
 * @typedef {object} Folder
 * @property {string} id
 * @property {string} name
 * @property {"folder"|"list"} type
 * @property {string|null} parentId   null for top level
 * @property {string[]} itemIds       ids of items directly in this list/folder (may repeat an item found elsewhere)
 */

/**
 * @typedef {object} Problem
 * @property {string} code      machine code, e.g. "record_truncated", "unknown_record_type"
 * @property {string} message   plain words for the report (never a coordinate or a user's name)
 * @property {number} count
 * @property {"report"|"dump"} [level]  "report" (default): shown to the user; "dump": only in the structure-only dump
 */

/**
 * Something the library holds that could not be converted. Shown to the user by name in the report (the report is
 * the user's own, local), never in the structure-only dump.
 * @typedef {object} NotConverted
 * @property {"waypoint"|"track"|"route"} kind
 * @property {string} name
 * @property {string} reason      a Problem code, e.g. "track_layout_unknown", "route_autoroute_only"
 * @property {string[]} listIds   the lists that mention it (so the report can say where it was)
 */

/**
 * @typedef {object} Library
 * @property {Item[]} items
 * @property {Folder[]} folders
 * @property {Problem[]} problems     everything that could not be read, counted, in plain words
 * @property {NotConverted[]} [notConverted]  items the library names that were not converted (default: none)
 * @property {string[]} [ambiguous]   ids of items whose list placement could not be decided because another item of
 *                                    the same kind has the same name (FORMAT.md §10); exported under "_Duplicate names"
 * @property {boolean} [treeMissing]  true when there was no usable FolderData.gfi: items are exported flat, never in an
 *                                    invented tree (decision B11)
 * @property {{ source: string, version: string|null }} meta   e.g. { source: "BaseCamp (Mac) AllData.gdb", version: "188" }
 */

export {};
