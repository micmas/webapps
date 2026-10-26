const variable = (name, values) => {
  const label = new TextEncoder().encode(`${name}\0`);
  const bytes = new Uint8Array(20 + label.length + 8 * values.length);
  const view = new DataView(bytes.buffer);
  [0, values.length, 1, 0, label.length].forEach((value, i) => view.setInt32(4 * i, value, true));
  bytes.set(label, 20);
  values.forEach((value, i) => view.setFloat64(20 + label.length + 8 * i, value, true));
  return bytes;
};

const affine = (matrix, translation) => {
  const parameters = variable("AffineTransform_double_3_3", [...matrix, ...translation]);
  const centre = variable("fixed", [0, 0, 0]);
  const bytes = new Uint8Array(parameters.length + centre.length);
  bytes.set(parameters);
  bytes.set(centre, parameters.length);
  return bytes;
};

/** A 30-degree LPS z rotation and an 8-mm LPS x translation, about the origin. */
export function transformOrderInputs(image) {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const rotation = [c, -s, 0, s, c, 0, 0, 0, 1];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return {
    "fixed.nii": image,
    "rot.mat": affine(rotation, [0, 0, 0]),
    "trans.mat": affine(identity, [8, 0, 0]),
    "rt.mat": affine(rotation, [8 * c, 8 * s, 0]),
    "tr.mat": affine(rotation, [8, 0, 0]),
    "rinvt.mat": affine(rotation, [-8 * c, -8 * s, 0]),
  };
}

export const TRANSFORM_ORDER_CASES = {
  "rot-trans": ["rot.mat", "trans.mat"],
  "trans-rot": ["trans.mat", "rot.mat"],
  "rot-inverse-trans": ["rot.mat", "inverse:trans.mat"],
  "inverse-trans-rot": ["inverse:trans.mat", "rot.mat"],
  "rt-single": ["rt.mat"],
  "tr-single": ["tr.mat"],
  "rinvt-single": ["rinvt.mat"],
};
