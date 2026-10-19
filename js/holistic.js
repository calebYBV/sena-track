export const FACE_BLENDSHAPES = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft", "eyeSquintRight",
  "eyeWideLeft", "eyeWideRight", "jawOpen", "mouthClose", "mouthFunnel",
  "mouthPucker", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft",
  "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight"
];
const FACE_FEATURE_SCALE = 2.5;
const FACE_WEIGHT_WITH_HANDS = 0.5;
const HAND_SHAPE_WEIGHT_WITH_FACE = 0.35;
const PLACEMENT_WEIGHT_WITH_FACE = 0.15;
const BIMANUAL_HAND_SHAPE_WEIGHT = 0.8;
const BIMANUAL_PLACEMENT_WEIGHT = 0.2;

const point = value => Array.isArray(value)
  ? { x: value[0], y: value[1], z: value[2] } : value;
const distance = (first, second, aspect) => {
  const a = point(first), b = point(second);
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y, a.z - b.z);
};
const finitePoints = points => Array.isArray(points) && points.length >= 468 &&
  points.every(value => {
    const p = point(value);
    return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  });

export function extractFaceFeatures(landmarks, blendshapes, transformationMatrix, aspect){
  if (!finitePoints(landmarks)) return null;
  const scores = new Map((blendshapes || []).map(category => [category.categoryName, category.score]));
  if (FACE_BLENDSHAPES.some(name => !Number.isFinite(scores.get(name)))) return null;
  if (!Array.isArray(transformationMatrix) || transformationMatrix.length < 16 ||
      !transformationMatrix.every(Number.isFinite)) return null;

  const width = distance(landmarks[33], landmarks[263], aspect);
  if (width < 1e-5) return null;
  const ratio = (a, b) => distance(landmarks[a], landmarks[b], aspect) / width;
  const m = transformationMatrix;
  const yaw = Math.atan2(m[8], m[10]);
  const pitch = Math.atan2(-m[9], Math.hypot(m[8], m[10]));
  const roll = Math.atan2(m[1], m[0]);
  const geometry = [
    ratio(10, 152), ratio(105, 159), ratio(334, 386),
    ratio(159, 145), ratio(386, 374), ratio(61, 291),
    ratio(13, 14), ratio(78, 308)
  ];
  const coefficients = FACE_BLENDSHAPES.map(name => scores.get(name));
  const features = [...coefficients, ...geometry, yaw / Math.PI, pitch / Math.PI, roll / Math.PI];
  return features.every(Number.isFinite) ? features : null;
}

function normalizeHand(landmarks, aspect){
  if (!Array.isArray(landmarks) || landmarks.length !== 21 ||
      landmarks.some(value => {
        const p = point(value);
        return !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z);
      })) return null;
  const wrist = point(landmarks[0]), scale = distance(landmarks[0], landmarks[9], aspect);
  if (scale < 1e-5) return null;
  return {
    shape: landmarks.flatMap(value => {
      const p = point(value);
      return [
      ((p.x - wrist.x) * aspect) / scale,
      (p.y - wrist.y) / scale,
      (p.z - wrist.z) / scale
      ];
    }),
    wrist: [wrist.x * aspect, wrist.y, wrist.z],
    scale
  };
}

export function extractHolisticFeatures(frame, aspect, required){
  const hands = {};
  for (const side of ["Left", "Right"]){
    const hand = frame.hands?.[side];
    if (hand){
      const normalized = normalizeHand(hand, aspect);
      if (normalized) hands[side] = normalized;
    }
  }
  if (required.left && !hands.Left || required.right && !hands.Right) return null;
  const face = required.face ? frame.faceFeatures : null;
  if (required.face && (!Array.isArray(face) || face.some(value => !Number.isFinite(value)))) return null;
  const faceOrigin = required.face && frame.faceLandmarks?.[1] ? point(frame.faceLandmarks[1]) : null;
  const eyeWidth = required.face && frame.faceLandmarks && frame.faceLandmarks.length > 263
    ? distance(frame.faceLandmarks[33], frame.faceLandmarks[263], aspect) : null;
  let placement = null;
  if (faceOrigin && eyeWidth > 1e-5){
    placement = {};
    for (const side of ["Left", "Right"]){
      if (hands[side]){
        placement[side] = [
          (hands[side].wrist[0] - faceOrigin.x * aspect) / eyeWidth,
          (hands[side].wrist[1] - faceOrigin.y) / eyeWidth,
          (hands[side].wrist[2] - faceOrigin.z) / eyeWidth
        ];
      }
    }
  } else if (hands.Left && hands.Right){
    const scale = (hands.Left.scale + hands.Right.scale) / 2;
    placement = {
      Left: hands.Left.wrist.map((value, index) =>
        (value - hands.Right.wrist[index]) / scale),
      Right: hands.Right.wrist.map((value, index) =>
        (value - hands.Left.wrist[index]) / scale)
    };
  }
  if (required.face && Object.keys(hands).some(side => required[side.toLowerCase()] && !placement?.[side])){
    return null;
  }
  return {
    hands: Object.fromEntries(Object.entries(hands)
      .filter(([side]) => required[side.toLowerCase()])
      .map(([side, hand]) => [side, hand.shape])),
    placement: placement && Object.fromEntries(Object.entries(placement)
      .filter(([side]) => required[side.toLowerCase()])),
    face: required.face ? face.slice() : null
  };
}

export function addMotionTrajectory(descriptors, frames, required, aspect){
  const sides = ["Left", "Right"].filter(side => required[side.toLowerCase()]);
  const tracks = Object.fromEntries(sides.map(side => {
    const points = frames.map(frame => {
      const hand = frame.hands?.[side];
      if (!Array.isArray(hand) || hand.length !== 21) return null;
      const wrist = point(hand[0]), palm = point(hand[9]);
      const scale = distance(wrist, palm, aspect);
      if (!Number.isFinite(scale) || scale < 1e-5) return null;
      return { wrist, scale };
    });
    if (points.some(value => !value)) return [side, null];
    const origin = points[0].wrist;
    const scale = points.reduce((sum, value) => sum + value.scale, 0) / points.length;
    return [side, points.map(({ wrist }) => [
      ((wrist.x - origin.x) * aspect) / scale,
      (wrist.y - origin.y) / scale,
      (wrist.z - origin.z) / scale
    ])];
  }));
  if (required.face){
    const points = frames.map(frame => {
      const landmarks = frame.faceLandmarks;
      if (!Array.isArray(landmarks) || landmarks.length <= 263) return null;
      const origin = point(landmarks[1]);
      const scale = distance(landmarks[33], landmarks[263], aspect);
      if (!Number.isFinite(scale) || scale < 1e-5) return null;
      return { origin, scale };
    });
    if (points.some(value => !value)) return null;
    const origin = points[0].origin;
    const scale = points.reduce((sum, value) => sum + value.scale, 0) / points.length;
    tracks.face = points.map(({ origin: current }) => [
      ((current.x - origin.x) * aspect) / scale,
      (current.y - origin.y) / scale,
      (current.z - origin.z) / scale
    ]);
  }
  if (Object.values(tracks).some(track => !track)) return null;
  return descriptors.map((descriptor, index) => ({
    ...descriptor,
    trajectory: Object.fromEntries([
      ...sides.map(side => [side, tracks[side][index]]),
      ...(required.face ? [["face", tracks.face[index]]] : [])
    ])
  }));
}

export function holisticDistance(a, b, required){
  const sides = ["Left", "Right"].filter(side => required[side.toLowerCase()]);
  const terms = [];
  const handShapeWeight = required.face ? HAND_SHAPE_WEIGHT_WITH_FACE
    : (sides.length === 2 ? BIMANUAL_HAND_SHAPE_WEIGHT : 1);
  const placementWeight = required.face ? PLACEMENT_WEIGHT_WITH_FACE
    : (sides.length === 2 ? BIMANUAL_PLACEMENT_WEIGHT : 0);
  for (const side of ["Left", "Right"]){
    if (!required[side.toLowerCase()]) continue;
    const av = a.hands?.[side], bv = b.hands?.[side];
    if (!Array.isArray(av) || !Array.isArray(bv) || av.length !== bv.length) return Infinity;
    terms.push({
      distance: Math.sqrt(av.reduce((sum, value, index) =>
        sum + (value - bv[index]) ** 2, 0)),
      weight: handShapeWeight / sides.length
    });
    const at = a.trajectory?.[side], bt = b.trajectory?.[side];
    if (Array.isArray(at) && Array.isArray(bt) && at.length === bt.length){
      terms.push({
        distance: Math.sqrt(at.reduce((sum, value, index) =>
          sum + (value - bt[index]) ** 2, 0)),
        weight: 0.5 / sides.length
      });
    }
  }
  if (required.face){
    if (!Array.isArray(a.face) || !Array.isArray(b.face) || a.face.length !== b.face.length) return Infinity;
    terms.push({
      distance: Math.sqrt(a.face.reduce((sum, value, index) =>
        sum + (value - b.face[index]) ** 2, 0)) * FACE_FEATURE_SCALE,
      weight: sides.length ? FACE_WEIGHT_WITH_HANDS : 1
    });
    const at = a.trajectory?.face, bt = b.trajectory?.face;
    if (Array.isArray(at) && Array.isArray(bt) && at.length === bt.length){
      terms.push({
        distance: Math.sqrt(at.reduce((sum, value, index) =>
          sum + (value - bt[index]) ** 2, 0)),
        weight: 0.5
      });
    }
  }
  if (placementWeight && a.placement && b.placement){
    for (const side of ["Left", "Right"]){
      if (!required[side.toLowerCase()]) continue;
      const av = a.placement[side], bv = b.placement[side];
      if (!Array.isArray(av) || !Array.isArray(bv)) return Infinity;
      terms.push({
        distance: Math.sqrt(av.reduce((sum, value, index) =>
          sum + (value - bv[index]) ** 2, 0)),
        weight: placementWeight / sides.length
      });
    }
  }
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0);
  return totalWeight
    ? terms.reduce((sum, term) => sum + term.distance * term.weight, 0) / totalWeight
    : Infinity;
}
