-- PalMesh's deliberately small, offline-only OSM schema. No remote shapefiles.
-- Tilemaker also sends assembled multipolygon relations to way_function.
node_keys = { "place", "amenity", "healthcare" }
way_keys = { "highway", "building", "waterway", "natural", "landuse", "amenity", "healthcare" }

local function names()
  for _, key in ipairs({ "name:ar", "name", "name:en" }) do
    local value = Find(key)
    if value ~= "" then Attribute(key, value) end
  end
end

local function poi_class()
  local amenity = Find("amenity")
  if amenity == "hospital" or amenity == "clinic" or amenity == "pharmacy"
      or amenity == "shelter" or amenity == "fire_station" or amenity == "drinking_water" then
    return amenity
  end
  return Find("healthcare")
end

function node_function()
  local place = Find("place")
  if place ~= "" then
    Layer("place", false)
    Attribute("class", place)
    names()
    if place == "city" then MinZoom(6)
    elseif place == "town" then MinZoom(9)
    elseif place == "village" then MinZoom(11)
    else MinZoom(13) end
  end
  local poi = poi_class()
  if poi ~= "" then
    Layer("poi", false)
    Attribute("class", poi)
    names()
  end
end

function way_function()
  local highway = Find("highway")
  if highway ~= "" then
    local zoom = 13
    if highway == "motorway" or highway == "trunk" or highway == "primary" then zoom = 6
    elseif highway == "secondary" then zoom = 9
    elseif highway == "tertiary" then zoom = 11
    elseif highway == "residential" or highway == "unclassified" then zoom = 12 end
    Layer("transportation", false)
    Attribute("class", highway)
    MinZoom(zoom)
    -- Access tags are descriptive OSM history, never a promise of passability.
    for _, key in ipairs({ "access", "surface", "bridge", "tunnel" }) do
      local value = Find(key)
      if value ~= "" then Attribute(key, value) end
    end
    if Find("name") ~= "" or Find("name:ar") ~= "" or Find("name:en") ~= "" then
      Layer("transportation_name", false)
      Attribute("class", highway)
      names()
    end
  end
  local building = Find("building")
  if building ~= "" and building ~= "no" and (IsClosed() or IsMultiPolygon()) then
    Layer("building", true)
    Attribute("class", building)
  end
  local waterway = Find("waterway")
  if waterway ~= "" then
    Layer("waterway", false)
    Attribute("class", waterway)
  end
  if Find("natural") == "coastline" then Layer("coastline", false) end
  if Find("natural") == "water" and (IsClosed() or IsMultiPolygon()) then
    Layer("water", true)
    names()
  end
  local landuse = Find("landuse")
  if landuse ~= "" and (IsClosed() or IsMultiPolygon()) then
    Layer("landuse", true)
    Attribute("class", landuse)
  end
  local poi = poi_class()
  if poi ~= "" and (IsClosed() or IsMultiPolygon()) then
    LayerAsCentroid("poi")
    Attribute("class", poi)
    names()
  end
end
