// Shared by the page and the AudioWorklet. The builder fills ALGORITHMS from
// web/algorithms.txt, the same table src/algorithms.rs reads: line N is algorithm N.
const OPS = 8;
const ALGORITHMS = __ALGORITHMS__;
// "8>7>3 2 1": OP8 modulates OP7, OP7 modulates OP3. Operators that modulate nothing are carriers.
function parseAlgorithm(spec) {
  const modulators = Array.from({length:OPS}, () => []);
  for (const chain of spec.trim().split(/\s+/)) {
    const ops = chain.split(">").map(n => Number(n) - 1);
    for (let k = 1; k < ops.length; k++) {
      if (!modulators[ops[k]].includes(ops[k-1])) modulators[ops[k]].push(ops[k-1]);
    }
  }
  const sources = new Set(modulators.flat());
  return {modulators, carriers:[...Array(OPS).keys()].filter(i => !sources.has(i))};
}
const ROUTES = ALGORITHMS.map(parseAlgorithm);
function route(algorithm) { return ROUTES[Math.min(ALGORITHMS.length, Math.max(1, algorithm)) - 1]; }

// FM–6 files had six operators and algorithms 1, 5 and 32. Each maps onto an
// FM–8 algorithm that contains the same wiring, with OP6 (feedback) moved to OP8.
// The two unused operators are silent, so the sound stays the same.
const LEGACY = {1:[10,[0,1,2,3,5,7]], 5:[72,[0,1,2,3,6,7]], 32:[88,[0,1,2,3,4,7]]};
const SILENT_OPERATOR = [1,0,0.006,0.3,1,0.15];
function upgradePatch(p) {
  if (!p || !Array.isArray(p.operators) || p.operators.length !== 6 || !LEGACY[p.algorithm]) return p;
  const [algorithm, places] = LEGACY[p.algorithm];
  const operators = Array.from({length:OPS}, () => SILENT_OPERATOR.slice());
  p.operators.forEach((op, i) => { operators[places[i]] = op; });
  return {...p, algorithm, operators};
}
