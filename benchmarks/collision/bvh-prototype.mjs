// Benchmark-only median-split BVH. It has no connection to the production picker.
// Coordinates are local metres (not float32 ECEF). Triangles use vec4 padding
// so the CPU and WGSL consume identical geometry and node layouts.
export function buildBvh(positions, indices, leafSize = 8) {
  const triangles = Array.from({ length: indices.length / 3 }, (_, i) => {
    const vertices = [0, 1, 2].flatMap(j => Array.from(positions.slice(indices[i * 3 + j] * 3, indices[i * 3 + j] * 3 + 3)));
    return { vertices, center: [0, 1, 2].map(a => (vertices[a] + vertices[a + 3] + vertices[a + 6]) / 3) };
  });
  const nodes = [], ordered = [];
  let depth = 0;
  function split(items, level) {
    depth = Math.max(depth, level);
    const index = nodes.length;
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const item of items) for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], item.vertices[v * 3 + a]);
      high[a] = Math.max(high[a], item.vertices[v * 3 + a]);
    }
    const node = { low, high, left: 0, right: 0, start: 0, count: 0 };
    nodes.push(node);
    if (items.length <= leafSize) {
      node.start = ordered.length;
      node.count = items.length;
      ordered.push(...items);
    } else {
      const extents = high.map((value, a) => value - low[a]);
      const axis = extents.indexOf(Math.max(...extents));
      items.sort((a, b) => a.center[axis] - b.center[axis]);
      const mid = Math.floor(items.length / 2);
      node.left = split(items.slice(0, mid), level + 1);
      node.right = split(items.slice(mid), level + 1);
    }
    return index;
  }
  if (!triangles.length) throw new Error("Fixture must contain triangles");
  split(triangles, 1);
  if (depth >= 64) throw new Error("GPU traversal stack is too small");
  const nodeData = new ArrayBuffer(nodes.length * 48);
  const floats = new Float32Array(nodeData), ints = new Uint32Array(nodeData);
  nodes.forEach((node, i) => {
    floats.set(node.low, i * 12); floats.set(node.high, i * 12 + 4);
    ints.set([node.left, node.right, node.start, node.count], i * 12 + 8);
  });
  const triangleData = new Float32Array(ordered.length * 12);
  ordered.forEach((triangle, i) => {
    for (let v = 0; v < 3; v++) triangleData.set(triangle.vertices.slice(v * 3, v * 3 + 3), i * 12 + v * 4);
  });
  return { nodeData, triangleData, nodes: nodes.length, triangles: triangles.length, depth };
}

export function createCpuBvhQuery(bvh) {
  const nodes = new Float32Array(bvh.nodeData), meta = new Uint32Array(bvh.nodeData), triangles = bvh.triangleData;
  const stack = new Uint32Array(64);
  return function query(rays, output) {
    for (let r = 0; r < rays.length / 8; r++) {
      const offset = r * 8;
      const ox = rays[offset], oy = rays[offset + 1], oz = rays[offset + 2];
      const dx = rays[offset + 4], dy = rays[offset + 5], dz = rays[offset + 6];
      const length = rays[offset + 3];
      let best = length, hit = false, nx = 0, ny = 0, nz = 0, size = 1;
      stack[0] = 0;
      while (size) {
        const node = stack[--size] * 12;
        let near = 0, far = best;
        for (let a = 0; a < 3; a++) {
          const origin = rays[offset + a], direction = rays[offset + 4 + a];
          if (direction === 0) {
            if (origin < nodes[node + a] - 0.001 || origin > nodes[node + 4 + a] + 0.001) { far = -1; break; }
          } else {
            const t0 = (nodes[node + a] - 0.001 - origin) / direction;
            const t1 = (nodes[node + 4 + a] + 0.001 - origin) / direction;
            near = Math.max(near, Math.min(t0, t1));
            far = Math.min(far, Math.max(t0, t1));
          }
        }
        if (near > far) continue;
        const count = meta[node + 11];
        if (!count) { stack[size++] = meta[node + 8]; stack[size++] = meta[node + 9]; continue; }
        const start = meta[node + 10];
        for (let i = start; i < start + count; i++) {
          const t = i * 12;
          const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
          const e1x = triangles[t + 4] - ax, e1y = triangles[t + 5] - ay, e1z = triangles[t + 6] - az;
          const e2x = triangles[t + 8] - ax, e2y = triangles[t + 9] - ay, e2z = triangles[t + 10] - az;
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-7) continue;
          const tx = ox - ax, ty = oy - ay, tz = oz - az;
          const u = (tx * px + ty * py + tz * pz) / det;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) / det;
          if (v < 0 || u + v > 1) continue;
          const distance = (e2x * qx + e2y * qy + e2z * qz) / det;
          if (distance < 0 || distance > best) continue;
          best = distance; hit = true;
          nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
        }
      }
      const scale = 1 / (Math.hypot(nx, ny, nz) || 1);
      output[r * 4] = hit ? best : -1;
      output[r * 4 + 1] = nx * scale; output[r * 4 + 2] = ny * scale; output[r * 4 + 3] = nz * scale;
    }
    return output;
  };
}

export const bvhShader = /* wgsl */`
struct Node { low: vec4f, high: vec4f, meta: vec4u }
struct Triangle { a: vec4f, b: vec4f, c: vec4f }
struct Ray { originLength: vec4f, direction: vec4f }
@group(0) @binding(0) var<storage, read> nodes: array<Node>;
@group(0) @binding(1) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(2) var<storage, read> rays: array<Ray>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  let ray = rays[id.x];
  let origin = ray.originLength.xyz;
  let direction = ray.direction.xyz;
  var best = ray.originLength.w;
  var hit = false;
  var normal = vec3f(0);
  var stack: array<u32, 64>;
  var size = 1u; stack[0] = 0u;
  while (size > 0u) {
    size -= 1u;
    let node = nodes[stack[size]];
    var near = 0.0; var far = best;
    for (var a = 0u; a < 3u; a += 1u) {
      if (direction[a] == 0.0) {
        if (origin[a] < node.low[a] - 0.001 || origin[a] > node.high[a] + 0.001) { far = -1.0; break; }
      } else {
        let t0 = (node.low[a] - 0.001 - origin[a]) / direction[a];
        let t1 = (node.high[a] + 0.001 - origin[a]) / direction[a];
        near = max(near, min(t0, t1)); far = min(far, max(t0, t1));
      }
    }
    if (near > far) { continue; }
    if (node.meta.w == 0u) {
      stack[size] = node.meta.x; stack[size + 1u] = node.meta.y; size += 2u; continue;
    }
    for (var i = node.meta.z; i < node.meta.z + node.meta.w; i += 1u) {
      let tri = triangles[i];
      let e1 = tri.b.xyz - tri.a.xyz; let e2 = tri.c.xyz - tri.a.xyz;
      let p = cross(direction, e2); let det = dot(e1, p);
      if (abs(det) < 1e-7) { continue; }
      let t = origin - tri.a.xyz; let u = dot(t, p) / det;
      if (u < 0.0 || u > 1.0) { continue; }
      let q = cross(t, e1); let v = dot(direction, q) / det;
      if (v < 0.0 || u + v > 1.0) { continue; }
      let distance = dot(e2, q) / det;
      if (distance < 0.0 || distance > best) { continue; }
      best = distance; hit = true; normal = normalize(cross(e1, e2));
    }
  }
  results[id.x] = vec4f(select(-1.0, best, hit), normal);
}
`;

export async function createGpuBvhQuery(device, pipeline, bvh, rayCount) {
  const makeBuffer = (size, usage) => device.createBuffer({ size, usage });
  const nodes = makeBuffer(bvh.nodeData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const triangles = makeBuffer(bvh.triangleData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const rays = makeBuffer(rayCount * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const results = makeBuffer(rayCount * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = makeBuffer(rayCount * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries:
    [nodes, triangles, rays, results].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  device.queue.writeBuffer(nodes, 0, bvh.nodeData);
  device.queue.writeBuffer(triangles, 0, bvh.triangleData);
  await device.queue.onSubmittedWorkDone();
  return {
    async query(data, output) {
      // Timing must include upload, encode, dispatch, copy, awaited readback,
      // and copying results into CPU-owned memory for the synchronous solver.
      device.queue.writeBuffer(rays, 0, data);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(rayCount / 64)); pass.end();
      encoder.copyBufferToBuffer(results, 0, readback, 0, rayCount * 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      output.set(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      return output;
    },
    dispose() { for (const buffer of [nodes, triangles, rays, results, readback]) buffer.destroy(); },
  };
}
