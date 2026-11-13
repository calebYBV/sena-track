import { addMotionTrajectory, extractHolisticFeatures } from "./holistic.js";

const MOTION_THRESHOLDS = Object.freeze({
  handTravel: 0.14,
  handShape: 0.12,
  faceTravel: 0.07,
  facialChange: 0.06,
  settleWindowMs: 250,
  settleStep: 0.06,
  minimumMotionMs: 250
});

function point(value){
  return Array.isArray(value) ? { x: value[0], y: value[1], z: value[2] } : value;
}

function normalizedChange(first, current){
  if (!Array.isArray(first) || first.length !== current?.length || !first.length) return 0;
  return Math.sqrt(first.reduce((sum, value, index) => sum + (value - current[index]) ** 2, 0) /
    first.length);
}

function handTravel(sequence, side){
  let peak = 0;
  for (const descriptor of sequence){
    const position = descriptor.trajectory?.[side];
    if (Array.isArray(position)){
      peak = Math.max(peak, Math.hypot(...position));
    }
  }
  return peak;
}

function faceTravel(sequence){
  let peak = 0;
  for (const descriptor of sequence){
    const position = descriptor.trajectory?.face;
    if (Array.isArray(position)){
      peak = Math.max(peak, Math.hypot(...position));
    }
  }
  return peak;
}

function adjacentChange(first, current, required, aspect){
  const firstDescriptor = extractHolisticFeatures(first, aspect, required);
  const currentDescriptor = extractHolisticFeatures(current, aspect, required);
  if (!firstDescriptor || !currentDescriptor) return Infinity;
  let peak = 0;
  for (const side of ["Left", "Right"]){
    if (!required[side.toLowerCase()]) continue;
    peak = Math.max(peak, normalizedChange(
      firstDescriptor.hands[side], currentDescriptor.hands[side]));
    const firstWrist = point(first.hands?.[side]?.[0]);
    const firstPalm = point(first.hands?.[side]?.[9]);
    const currentWrist = point(current.hands?.[side]?.[0]);
    const currentPalm = point(current.hands?.[side]?.[9]);
    if (firstWrist && firstPalm && currentWrist && currentPalm){
      const palmWidth = Math.max(1e-5, Math.hypot(
        (firstPalm.x - firstWrist.x) * aspect,
        firstPalm.y - firstWrist.y,
        firstPalm.z - firstWrist.z
      ));
      peak = Math.max(peak, Math.hypot(
        (currentWrist.x - firstWrist.x) * aspect,
        currentWrist.y - firstWrist.y,
        currentWrist.z - firstWrist.z
      ) / palmWidth);
    }
  }
  if (required.face){
    peak = Math.max(peak, normalizedChange(firstDescriptor.face, currentDescriptor.face));
  }
  const firstHead = point(first.faceLandmarks?.[1]);
  const currentHead = point(current.faceLandmarks?.[1]);
  if (required.face && firstHead && currentHead){
    const firstLeftEye = point(first.faceLandmarks[33]);
    const firstRightEye = point(first.faceLandmarks[263]);
    const eyeWidth = Math.hypot(
      (firstLeftEye.x - firstRightEye.x) * aspect,
      firstLeftEye.y - firstRightEye.y,
      firstLeftEye.z - firstRightEye.z
    );
    if (eyeWidth > 1e-5){
      peak = Math.max(peak, Math.hypot(
        (currentHead.x - firstHead.x) * aspect,
        currentHead.y - firstHead.y,
        currentHead.z - firstHead.z
      ) / eyeWidth);
    }
  }
  return peak;
}

export function analyzeUnifiedCapture(frames, required, aspect){
  if (!Array.isArray(frames) || frames.length < 8 ||
      !Number.isFinite(aspect) || aspect <= 0){
    return { kind: null, reason: "insufficient-frames" };
  }
  const descriptors = frames.map(frame => extractHolisticFeatures(frame, aspect, required));
  if (descriptors.some(descriptor => !descriptor)){
    return { kind: null, reason: "missing-required-components" };
  }
  const sequence = addMotionTrajectory(descriptors, frames, required, aspect);
  if (!sequence) return { kind: null, reason: "invalid-trajectory" };

  const travel = {
    left: required.left ? handTravel(sequence, "Left") : 0,
    right: required.right ? handTravel(sequence, "Right") : 0,
    face: required.face ? faceTravel(sequence) : 0
  };
  const handShapeChange = Math.max(0, ...["Left", "Right"]
    .filter(side => required[side.toLowerCase()])
    .map(side => Math.max(0, ...sequence.map(descriptor =>
      normalizedChange(descriptors[0].hands[side], descriptor.hands[side])))));
  const facialChange = required.face
    ? Math.max(0, ...sequence.map(descriptor =>
      normalizedChange(descriptors[0].face, descriptor.face))) : 0;
  const durationMs = frames.at(-1).time - frames[0].time;
  const movementDetected =
    travel.left >= MOTION_THRESHOLDS.handTravel ||
    travel.right >= MOTION_THRESHOLDS.handTravel ||
    travel.face >= MOTION_THRESHOLDS.faceTravel ||
    handShapeChange >= MOTION_THRESHOLDS.handShape ||
    facialChange >= MOTION_THRESHOLDS.facialChange;

  const settleStart = frames.at(-1).time - MOTION_THRESHOLDS.settleWindowMs;
  const settleFrames = frames.filter(frame => frame.time >= settleStart);
  const settledAtEnd = settleFrames.length >= 2 &&
    settleFrames.every((frame, index) => index === 0 ||
      adjacentChange(settleFrames[index - 1], frame, required, aspect) <= MOTION_THRESHOLDS.settleStep);
  const completeMotion = movementDetected &&
    durationMs >= MOTION_THRESHOLDS.minimumMotionMs && settledAtEnd;

  return {
    kind: completeMotion ? "motion" : movementDetected ? null : "static",
    reason: movementDetected && !completeMotion ? "incomplete-motion" : null,
    motionDetected: movementDetected,
    settledAtEnd,
    durationMs,
    travel,
    handShapeChange,
    facialChange,
    rawHolisticSequence: sequence
  };
}

export { MOTION_THRESHOLDS };
