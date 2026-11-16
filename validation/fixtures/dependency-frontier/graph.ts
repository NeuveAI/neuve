// Literal graph used by the before/after investigation evaluation.
// Never execute the recursive functions. Their edges are extraction fixtures.
export function entry() {
  return middle();
}
export function middle() {
  return leaf();
}
export function leaf() {
  return terminal();
}
export function terminal() {
  return 1;
}

export function fanout() {
  return left() + center() + right();
}
export function left() {
  return shared();
}
export function center() {
  return shared();
}
export function right() {
  return 3;
}
export function shared() {
  return 4;
}

export function cycleA(): number {
  return cycleB();
}
export function cycleB(): number {
  return cycleA();
}
export function self(): number {
  return self();
}

export function repeated() {
  return middle() + middle();
}
export class Made {
  value = 1;
}
export function mixed() {
  middle();
  return new Made();
}
export function unknown() {
  return missingDependency();
}

import { readFileSync } from "fs";
export function readConfig(name: string) {
  return readFileSync(name, "utf8");
}
