/*
 * The residual tile decode of lib/decodeKernel.mjs in C, to compare
 * WebAssembly with JavaScript on the same arithmetic. Built by run-cpu.mjs
 * with Emscripten when emcc is installed:
 *
 *   emcc -O3 --no-entry -sSTANDALONE_WASM -sINITIAL_MEMORY=67108864 wasm/decode_kernel.c -o decode_kernel.wasm
 */
#include <stdint.h>

int unpack_integers(const uint8_t* bytes, int32_t* values, int count) {
  int at = 0;
  for (int i = 0; i < count; i++) {
    uint32_t z = bytes[at++];
    if (z == 255) {
      z = (uint32_t)bytes[at] | ((uint32_t)bytes[at + 1] << 8) | ((uint32_t)bytes[at + 2] << 16) | ((uint32_t)bytes[at + 3] << 24);
      at += 4;
    }
    values[i] = (z & 1) ? -(int32_t)((z + 1) / 2) : (int32_t)(z / 2);
  }
  return at;
}

void inverse_haar_equal(const float* parent, const int32_t* details, int width, int height, const float* steps, float* out) {
  const int parents = width * height, child_width = width * 2, children = parents * 4;
  for (int plane = 0; plane < 3; plane++) {
    const int32_t* band = details + plane * 3 * parents;
    const float s0 = steps[plane * 3] / 2, s1 = steps[plane * 3 + 1] / 2, s2 = steps[plane * 3 + 2] / 2;
    const float* from = parent + plane * parents;
    float* to = out + plane * children;
    for (int y = 0; y < height; y++) {
      int p = y * width;
      float* c = to + 2 * y * child_width;
      for (int x = 0; x < width; x++, p++, c += 2) {
        const float value = from[p], half = band[2 * parents + p] * s2;
        const float top = value + half, bottom = value - half;
        const float a = band[p] * s0, b = band[parents + p] * s1;
        c[0] = top + a; c[1] = top - a;
        c[child_width] = bottom + b; c[child_width + 1] = bottom - b;
      }
    }
  }
}

static inline uint8_t to_byte(float value) {
  return value < 0 ? 0 : value > 255 ? 255 : (uint8_t)(value + 0.5f);
}

void ycc_to_rgba(const float* planes, int count, uint8_t* rgba) {
  for (int i = 0; i < count; i++) {
    const float y = planes[i], cb = planes[count + i] - 128, cr = planes[2 * count + i] - 128;
    rgba[i * 4] = to_byte(y + 1.402f * cr);
    rgba[i * 4 + 1] = to_byte(y - 0.344136f * cb - 0.714136f * cr);
    rgba[i * 4 + 2] = to_byte(y + 1.772f * cb);
    rgba[i * 4 + 3] = 255;
  }
}
