import { dot, rightOf } from '../geometry.js';
import type { Segment } from '../city/types.js';

/** Within 60° of square across: traffic heading this way comes in from the right. */
const FROM_RIGHT = -0.5;

/**
 * Right of way at an unsignalised (or flashing) junction: the higher priority goes first; between equals,
 * the approach on the right (an oncoming one is not, left turns give way to it separately).
 */
export function yieldsTo(mine: Segment, theirs: Segment): boolean {
  if (theirs.priority !== mine.priority) return theirs.priority > mine.priority;
  return dot(theirs.dirOut, rightOf(mine.dirOut)) < FROM_RIGHT;
}
