#ifndef PALMESH_VECTOR_TILE_VALIDATION_H
#define PALMESH_VECTOR_TILE_VALIDATION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <zlib.h>

#define PM_TILE_MAX_STORED_BYTES (1024U * 1024U)
#define PM_TILE_MAX_DECODED_BYTES (4U * 1024U * 1024U)

/* Kept independent of Foundation so malformed and compressed tile input can be
 * exercised on Linux using the very same parser shipped in the iOS host. */
static inline bool PMTileReadVarint(const uint8_t *bytes, size_t size, size_t *offset, uint64_t *value) {
  *value = 0;
  for (unsigned index = 0; index < 10 && *offset < size; index++) {
    uint8_t byte = bytes[(*offset)++];
    if (index == 9 && byte > 1) return false;
    *value |= ((uint64_t)(byte & 127)) << (index * 7);
    if (!(byte & 128)) return true;
  }
  return false;
}

static inline bool PMTileValidateFraming(const uint8_t *bytes, size_t size) {
  size_t offset = 0;
  bool layer = false;
  while (offset < size) {
    uint64_t tag, length;
    if (!PMTileReadVarint(bytes, size, &offset, &tag) || tag == 0 || tag > UINT32_MAX || (tag >> 3) == 0) return false;
    switch (tag & 7) {
      case 0: if (!PMTileReadVarint(bytes, size, &offset, &length)) return false; continue;
      case 1: length = 8; break;
      case 2: if (!PMTileReadVarint(bytes, size, &offset, &length)) return false; break;
      case 5: length = 4; break;
      default: return false;
    }
    if (length > size - offset) return false;
    /* Tile.layers is field 3, wire type 2. MapLibre owns layer/geometry decoding;
     * require a nonempty layer envelope without imposing a new schema dialect. */
    if (tag == 26 && length > 0) layer = true;
    offset += (size_t)length;
  }
  return layer;
}

static inline bool PMTileValidateStored(const uint8_t *bytes, size_t size) {
  if (!bytes || size < 1 || size > PM_TILE_MAX_STORED_BYTES) return false;
  if (size < 2 || bytes[0] != 31 || bytes[1] != 139) return PMTileValidateFraming(bytes, size);

  z_stream stream = {0};
  if (inflateInit2(&stream, 16 + MAX_WBITS) != Z_OK) return false;
  uint8_t *decoded = malloc(PM_TILE_MAX_DECODED_BYTES);
  if (!decoded) { inflateEnd(&stream); return false; }
  stream.next_in = (Bytef *)bytes;
  stream.avail_in = (uInt)size;
  stream.next_out = decoded;
  stream.avail_out = PM_TILE_MAX_DECODED_BYTES;
  int status = inflate(&stream, Z_FINISH);
  /* Exactly one complete gzip member, with a verified CRC and no trailing data.
   * A fixed output budget bounds memory even for tiny compression bombs. */
  bool valid = status == Z_STREAM_END && stream.avail_in == 0
    && PMTileValidateFraming(decoded, (size_t)stream.total_out);
  inflateEnd(&stream);
  free(decoded);
  return valid;
}

#endif
