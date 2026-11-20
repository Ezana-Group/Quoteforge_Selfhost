// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Ovid International Ltd. See LICENSE.
/*
 * multi-part-import.js — QuoteForge
 *
 * Parses a single uploaded 3D file that contains MULTIPLE separate
 * parts/plates/bodies, and splits it into one importable entry per
 * part — so someone with one combined project file doesn't have to
 * manually re-type "Plate_2", "Plate_3"... and attach files one at a
 * time.
 *
 * Deliberately format-based, not slicer-based: it works the same
 * whether the file came from Bambu Studio, OrcaSlicer, PrusaSlicer,
 * Cura, or straight out of CAD software — because it splits by the
 * file format's own object/solid structure, not by looking for any
 * one slicer's proprietary metadata.
 *
 *   .stl  — a single STL can contain multiple disconnected solid
 *           bodies (common when CAD software exports "everything in
 *           one file"). Detected via mesh-triangle adjacency (flood
 *           fill over shared edges) — no slicer involved at all.
 *   .3mf  — the 3MF core spec (3D/3dmodel.model) lists named <object>
 *           elements. This part of 3MF is standardized and shared by
 *           every slicer/CAD tool that writes 3MF — only the extra
 *           per-slicer metadata (time/weight predictions) differs,
 *           and that's read as a best-effort bonus, never required.
 *   .obj  — named groups ("o " / "g " lines) are treated as separate
 *           parts, same idea as STL islands but using OBJ's own
 *           naming instead of geometry detection.
 *
 * What it does NOT attempt: STEP/IGES or other native CAD assembly
 * formats. Those need a real CAD geometry kernel (B-rep/NURBS), which
 * is a much bigger dependency than this file/module is scoped for —
 * intentionally left out rather than half-implemented.
 *
 * Every part's weight is an ESTIMATE derived from mesh volume × the
 * material's density, once the user picks a material for that row —
 * it is not a slicer's actual sliced-weight prediction (STL/OBJ have
 * no such data; only some 3MF project files do, and that's read only
 * as an optional bonus when present).
 */

// ===== Shared geometry helpers =====

// Signed volume of the tetrahedron formed by the origin and one
// triangle — summing this over every triangle in a closed mesh gives
// the mesh's enclosed volume (a standard technique; each triangle's
// winding/orientation determines the sign, so open/inverted meshes
// can give a below-real or negative estimate — expected and noted
// in the UI rather than silently "corrected").
function signedTriangleVolume(p1, p2, p3) {
  return (
    p1[0] * (p2[1] * p3[2] - p3[1] * p2[2]) -
    p1[1] * (p2[0] * p3[2] - p3[0] * p2[2]) +
    p1[2] * (p2[0] * p3[1] - p3[0] * p2[1])
  ) / 6.0;
}

function meshVolumeCm3(triangles) {
  let vol = 0;
  for (const t of triangles) vol += signedTriangleVolume(t[0], t[1], t[2]);
  // STL/3MF/OBJ coordinates are conventionally millimeters; convert
  // mm^3 to cm^3 (÷1000) since material density is given per cm^3.
  return Math.abs(vol) / 1000;
}

function boundingBox(triangles) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) {
    for (const p of t) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// ===== STL parsing (binary + ASCII), with multi-body splitting =====

function isBinarySTL(buffer) {
  // Binary STL: 80-byte header + 4-byte triangle count + 50 bytes per
  // triangle. If the file size matches that formula exactly, treat it
  // as binary; ASCII STL starts with the literal text "solid " but
  // some binary files also start with that string, so size-matching
  // is the more reliable check.
  if (buffer.byteLength < 84) return false;
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const expectedSize = 84 + triCount * 50;
  return expectedSize === buffer.byteLength;
}

function parseBinarySTL(buffer) {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const triangles = [];
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    offset += 12; // skip normal vector
    const p1 = [dv.getFloat32(offset, true), dv.getFloat32(offset + 4, true), dv.getFloat32(offset + 8, true)];
    offset += 12;
    const p2 = [dv.getFloat32(offset, true), dv.getFloat32(offset + 4, true), dv.getFloat32(offset + 8, true)];
    offset += 12;
    const p3 = [dv.getFloat32(offset, true), dv.getFloat32(offset + 4, true), dv.getFloat32(offset + 8, true)];
    offset += 12;
    offset += 2; // skip attribute byte count
    triangles.push([p1, p2, p3]);
  }
  return triangles;
}

function parseAsciiSTL(text) {
  const triangles = [];
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  let current = [];
  while ((match = vertexRe.exec(text)) !== null) {
    current.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
    if (current.length === 3) {
      triangles.push(current);
      current = [];
    }
  }
  return triangles;
}

// Splits a flat triangle list into separate solid "islands" using
// shared-vertex adjacency (union-find) — this is what makes multi-body
// STL splitting possible without any slicer/CAD-specific metadata.
function splitTrianglesIntoIslands(triangles) {
  const n = triangles.length;
  if (n === 0) return [];

  // Key vertices by rounded coordinate so triangles sharing a vertex
  // (within floating-point tolerance) are recognized as connected.
  const keyOf = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
  const vertexToTriangles = new Map();
  triangles.forEach((tri, idx) => {
    tri.forEach((p) => {
      const k = keyOf(p);
      if (!vertexToTriangles.has(k)) vertexToTriangles.set(k, []);
      vertexToTriangles.get(k).push(idx);
    });
  });

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  vertexToTriangles.forEach((triIdxs) => {
    for (let i = 1; i < triIdxs.length; i++) union(triIdxs[0], triIdxs[i]);
  });

  const islands = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!islands.has(root)) islands.set(root, []);
    islands.get(root).push(triangles[i]);
  }
  return Array.from(islands.values());
}

async function parseSTLFile(file) {
  const buffer = await file.arrayBuffer();
  let triangles;
  if (isBinarySTL(buffer)) {
    triangles = parseBinarySTL(buffer);
  } else {
    triangles = parseAsciiSTL(new TextDecoder().decode(buffer));
  }
  if (triangles.length === 0) {
    throw new Error("Couldn't find any triangles in this STL file — it may be empty or corrupted.");
  }
  const islands = splitTrianglesIntoIslands(triangles);
  return islands.map((tris, i) => ({
    name: islands.length > 1 ? `Part ${i + 1}` : (file.name.replace(/\.stl$/i, "") || "Part 1"),
    volumeCm3: meshVolumeCm3(tris),
    bbox: boundingBox(tris),
    triangleCount: tris.length,
    sourceFileName: file.name,
  }));
}

// ===== OBJ parsing (named groups as separate parts) =====

async function parseOBJFile(file) {
  const text = await file.text();
  const lines = text.split("\n");
  const allVertices = [];
  const groups = []; // { name, faces: [[v,v,v], ...] }
  let current = { name: file.name.replace(/\.obj$/i, "") || "Part 1", faceVertexIdxs: [] };
  groups.push(current);

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const parts = line.split(/\s+/);
      allVertices.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (line.startsWith("o ") || line.startsWith("g ")) {
      const name = line.slice(2).trim() || `Part ${groups.length + 1}`;
      // Only start a new group if the current one already has faces —
      // avoids creating an empty leading group when a file opens with
      // a group declaration before any geometry.
      if (current.faceVertexIdxs.length > 0) {
        current = { name, faceVertexIdxs: [] };
        groups.push(current);
      } else {
        current.name = name;
      }
    } else if (line.startsWith("f ")) {
      // Faces reference vertex indices (1-based, optionally with
      // /texture/normal suffixes) — take just the vertex index and
      // fan-triangulate anything beyond a triangle.
      const idxs = line.slice(2).trim().split(/\s+/).map((token) => {
        const vIdx = parseInt(token.split("/")[0], 10);
        return vIdx > 0 ? vIdx - 1 : allVertices.length + vIdx; // supports negative/relative indices
      });
      for (let i = 1; i < idxs.length - 1; i++) {
        current.faceVertexIdxs.push([idxs[0], idxs[i], idxs[i + 1]]);
      }
    }
  }

  const usableGroups = groups.filter((g) => g.faceVertexIdxs.length > 0);
  if (usableGroups.length === 0) {
    throw new Error("Couldn't find any geometry in this OBJ file.");
  }

  return usableGroups.map((g) => {
    const triangles = g.faceVertexIdxs.map(([a, b, c]) => [allVertices[a], allVertices[b], allVertices[c]]).filter(
      (t) => t[0] && t[1] && t[2]
    );
    return {
      name: g.name,
      volumeCm3: meshVolumeCm3(triangles),
      bbox: boundingBox(triangles),
      triangleCount: triangles.length,
      sourceFileName: file.name,
    };
  });
}

// ===== 3MF parsing (via vendored JSZip) — works across every slicer =====

async function parse3MFFile(file) {
  if (typeof JSZip === "undefined") {
    throw new Error("3MF support needs vendor/jszip.min.js to be loaded on this page.");
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const modelEntry = zip.file("3D/3dmodel.model");
  if (!modelEntry) {
    throw new Error("This doesn't look like a valid 3MF file — no 3D/3dmodel.model found inside.");
  }
  const xmlText = await modelEntry.async("text");
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");

  const objectEls = Array.from(xml.getElementsByTagName("object"));
  if (objectEls.length === 0) {
    throw new Error("No objects found in this 3MF file's model data.");
  }

  const parts = objectEls.map((objEl, i) => {
    const name = objEl.getAttribute("name") || objEl.getAttribute("partnumber") || `Part ${i + 1}`;
    const meshEl = objEl.getElementsByTagName("mesh")[0];
    let triangles = [];
    if (meshEl) {
      const verticesEls = Array.from(meshEl.getElementsByTagName("vertex"));
      const vertices = verticesEls.map((v) => [
        parseFloat(v.getAttribute("x")),
        parseFloat(v.getAttribute("y")),
        parseFloat(v.getAttribute("z")),
      ]);
      const triangleEls = Array.from(meshEl.getElementsByTagName("triangle"));
      triangles = triangleEls.map((t) => {
        const v1 = parseInt(t.getAttribute("v1"), 10);
        const v2 = parseInt(t.getAttribute("v2"), 10);
        const v3 = parseInt(t.getAttribute("v3"), 10);
        return [vertices[v1], vertices[v2], vertices[v3]];
      }).filter((t) => t[0] && t[1] && t[2]);
    }
    return {
      name,
      volumeCm3: triangles.length ? meshVolumeCm3(triangles) : null,
      bbox: triangles.length ? boundingBox(triangles) : null,
      triangleCount: triangles.length,
      sourceFileName: file.name,
      // Filled in below if slicer metadata is found — stays null
      // otherwise, and the UI treats that as "not available" rather
      // than guessing.
      slicerWeightG: null,
      slicerTimeHours: null,
    };
  });

  // Best-effort bonus: Bambu Studio / OrcaSlicer project files include
  // Metadata/slice_info.config with per-plate weight/time predictions.
  // This is read opportunistically — if it's missing or in an
  // unrecognized shape, the parts above are still returned using only
  // the geometry-derived volume estimate.
  try {
    const sliceInfoEntry = zip.file("Metadata/slice_info.config");
    if (sliceInfoEntry) {
      const sliceXmlText = await sliceInfoEntry.async("text");
      const sliceXml = new DOMParser().parseFromString(sliceXmlText, "application/xml");
      const plateEls = Array.from(sliceXml.getElementsByTagName("plate"));
      plateEls.forEach((plateEl, i) => {
        const metadataEls = Array.from(plateEl.getElementsByTagName("metadata"));
        const getMeta = (key) => {
          const el = metadataEls.find((m) => m.getAttribute("key") === key);
          return el ? el.getAttribute("value") : null;
        };
        const weight = parseFloat(getMeta("weight"));
        const time = getMeta("prediction"); // seconds, in Bambu/Orca's convention
        if (parts[i]) {
          if (Number.isFinite(weight)) parts[i].slicerWeightG = weight;
          if (time && Number.isFinite(parseFloat(time))) parts[i].slicerTimeHours = parseFloat(time) / 3600;
        }
      });
    }
  } catch (e) {
    // Slicer metadata is a bonus, not a requirement — any parsing
    // issue here is silently ignored rather than failing the import.
  }

  return parts;
}

// ===== Public entry point =====

const MULTI_PART_SUPPORTED_EXTENSIONS = [".stl", ".3mf", ".obj"];

function getFileExtension(fileName) {
  const m = fileName.toLowerCase().match(/\.[^.]+$/);
  return m ? m[0] : "";
}

// Returns an array of { name, volumeCm3, bbox, triangleCount,
// sourceFileName, slicerWeightG, slicerTimeHours } — one entry per
// detected part/plate/body. Throws a plain Error with a
// user-presentable message on failure.
async function parseMultiPartFile(file) {
  const ext = getFileExtension(file.name);
  if (ext === ".stl") return parseSTLFile(file);
  if (ext === ".obj") return parseOBJFile(file);
  if (ext === ".3mf") return parse3MFFile(file);
  throw new Error(
    `"${ext || file.name}" isn't a format QuoteForge can split into multiple parts yet. ` +
    `Supported: ${MULTI_PART_SUPPORTED_EXTENSIONS.join(", ")}.`
  );
}
