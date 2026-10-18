-- osm2pgsql flex style osm-context@1.0.0 (specs/012 research R3).
-- One row per (OSM object, class) into osm.context_import; scripts/osm/finalize.ts turns it into
-- osm.context_features (geography + indexes). Lines and areas keep their real shape: distances are
-- measured to the nearest point of the geometry, 0 inside an area. Changing a mapping here means
-- re-importing and bumping the version in src/modules/verification/geo/osm-schema.ts.

local tbl = osm2pgsql.define_table({
    name = 'context_import',
    schema = 'osm',
    ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
    columns = {
        { column = 'class', type = 'text', not_null = true },
        { column = 'name', type = 'text' },
        { column = 'tag', type = 'text', not_null = true },
        { column = 'geom', type = 'geometry', projection = 4326, not_null = true },
    },
})

local function set(list)
    local s = {}
    for _, v in ipairs(list) do s[v] = true end
    return s
end

local WATERWAY_LINES = set({ 'river', 'canal', 'stream', 'tidal_channel' })
local WATER_AREAS = set({ 'river', 'canal', 'stream' })
local SCHOOLS = set({ 'school', 'kindergarten', 'college', 'university' })
local PARKS = set({ 'park', 'garden' })
local STREETS = set({
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
    'residential', 'unclassified', 'living_street',
})
local ALLEY_HIGHWAYS = set({ 'residential', 'living_street', 'service', 'footway', 'path' })
local ALLEY_PREFIXES = { 'Hẻm', 'Ngõ', 'Ngách', 'Kiệt' }

local function starts_with(s, prefix)
    return s ~= nil and s:sub(1, #prefix) == prefix
end

local function is_alley_name(name)
    for _, p in ipairs(ALLEY_PREFIXES) do
        if starts_with(name, p) then return true end
    end
    return false
end

-- Classes of an object as { class, 'key=value' } pairs; `area` = closed way / multipolygon.
local function classes(t, area)
    local out = {}
    local function add(class, key) out[#out + 1] = { class, key .. '=' .. t[key] } end

    if WATERWAY_LINES[t.waterway] and not area then add('waterway', 'waterway') end
    if t.natural == 'water' and WATER_AREAS[t.water] and area then out[#out + 1] = { 'waterway', 'water=' .. t.water } end
    if t.natural == 'beach' and area then add('beach', 'natural') end
    if t.natural == 'coastline' and not area then add('beach', 'natural') end
    if t.amenity == 'marketplace' then add('market', 'amenity') end
    if SCHOOLS[t.amenity] then add('school', 'amenity') end
    if (PARKS[t.leisure] and area) then add('park', 'leisure') end
    if t.landuse == 'village_green' and area then add('park', 'landuse') end
    if t.landuse == 'industrial' and area then add('industrial', 'landuse') end
    if not area and t.highway then
        if (t.highway == 'service' and t.service == 'alley')
            or (ALLEY_HIGHWAYS[t.highway] and is_alley_name(t.name)) then
            add('alley', 'highway')
        end
        if STREETS[t.highway] then add('street', 'highway') end
    end
    return out
end

local function insert_all(object, list, geom)
    for _, c in ipairs(list) do
        tbl:insert({ class = c[1], name = object.tags.name, tag = c[2], geom = geom })
    end
end

function osm2pgsql.process_node(object)
    local t = object.tags
    local list = {}
    if t.amenity == 'marketplace' then list[#list + 1] = { 'market', 'amenity=marketplace' } end
    if SCHOOLS[t.amenity] then list[#list + 1] = { 'school', 'amenity=' .. t.amenity } end
    -- Coverage only: how densely the area around a point is mapped.
    if t.amenity then list[#list + 1] = { 'poi', 'amenity=' .. t.amenity }
    elseif t.shop then list[#list + 1] = { 'poi', 'shop=' .. t.shop } end
    if #list > 0 then insert_all(object, list, object:as_point()) end
end

-- A closed way is an area when its tags describe one (a closed street or canal stays a line).
local AREA_KEYS = { 'natural', 'leisure', 'landuse', 'amenity' }

function osm2pgsql.process_way(object)
    local t = object.tags
    local area = false
    if object.is_closed and t.area ~= 'no' then
        for _, k in ipairs(AREA_KEYS) do
            if t[k] and t.natural ~= 'coastline' then area = true end
        end
    end
    local list = classes(t, area)
    if #list == 0 then return end
    insert_all(object, list, area and object:as_polygon() or object:as_linestring())
end

function osm2pgsql.process_relation(object)
    if object.tags.type ~= 'multipolygon' then return end
    local list = classes(object.tags, true)
    if #list == 0 then return end
    insert_all(object, list, object:as_multipolygon())
end
