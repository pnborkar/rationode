"""A small classification-tree learner (CART, Gini impurity), pure Python.

Rationode's own learner so the same code runs offline and live in the Scenario
lab (no scikit-learn). Splits are human-readable conditions:
    numeric:      attr >= threshold   /  attr < threshold
    boolean:      attr = true         /  attr = false
    categorical:  attr IN [value]     /  attr NOT IN [value]
"""

import math
from collections import Counter
from dataclasses import dataclass, field

ALGORITHM_VERSION = "rn-tree-0.2"


@dataclass
class Feature:
    name: str
    kind: str   # "numeric" | "boolean" | "categorical"
    integer: bool = False


@dataclass
class Split:
    feature: Feature
    value: object   # threshold (numeric), True (boolean), category (categorical)
    gain: float

    def goes_left(self, x: dict) -> bool:
        v = x.get(self.feature.name)
        if self.feature.kind == "numeric":
            return v is not None and v >= self.value
        if self.feature.kind == "boolean":
            return bool(v) is True
        return v == self.value

    def conditions(self) -> tuple[tuple, tuple]:
        """(attribute, operator, value) for the left and right branch."""
        n = self.feature.name
        if self.feature.kind == "numeric":
            return (n, ">=", self.value), (n, "<", self.value)
        if self.feature.kind == "boolean":
            return (n, "=", True), (n, "=", False)
        return (n, "IN", [self.value]), (n, "NOT IN", [self.value])


@dataclass
class Node:
    indices: list[int]
    depth: int
    counts: Counter
    split: Split | None = None
    left: "Node | None" = None
    right: "Node | None" = None
    path: str = "r"

    @property
    def is_leaf(self) -> bool:
        return self.split is None

    @property
    def support(self) -> int:
        return len(self.indices)

    def leaves(self):
        if self.is_leaf:
            yield self
        else:
            yield from self.left.leaves()
            yield from self.right.leaves()


def gini(counts: Counter, n: int) -> float:
    return 1.0 - sum((c / n) ** 2 for c in counts.values()) if n else 0.0


def chi2_sf(x: float, df: int) -> float:
    """Upper-tail probability of the chi-square distribution (Wilson-Hilferty for df > 1)."""
    if x <= 0:
        return 1.0
    if df == 1:
        return math.erfc(math.sqrt(x / 2))
    z = ((x / df) ** (1 / 3) - (1 - 2 / (9 * df))) / math.sqrt(2 / (9 * df))
    return 0.5 * math.erfc(z / math.sqrt(2))


def split_p_value(parent: Counter, left: Counter) -> float:
    """Chi-square test of independence between branch (left/right) and label."""
    right = parent - left
    n, nl = sum(parent.values()), sum(left.values())
    nr = n - nl
    labels = [k for k, v in parent.items() if v > 0]
    if len(labels) < 2 or nl == 0 or nr == 0:
        return 1.0
    x = 0.0
    for k in labels:
        for side, n_side in ((left, nl), (right, nr)):
            expected = parent[k] * n_side / n
            x += (side.get(k, 0) - expected) ** 2 / expected
    return chi2_sf(x, len(labels) - 1)


@dataclass
class TreeLearner:
    max_depth: int = 4
    min_leaf: int = 50
    min_gain: float = 0.002           # minimum weighted impurity decrease, relative to root size
    max_thresholds: int = 64
    alpha: float = 0.001               # a split must be statistically significant, not just reduce impurity
    features: list[Feature] = field(default_factory=list)

    def fit(self, X: list[dict], y: list[str]) -> Node:
        self.X, self.y, self.n_root = X, y, len(y)
        root = Node(list(range(len(y))), 0, Counter(y))
        self._grow(root)
        return root

    def _grow(self, node: Node) -> None:
        if node.depth >= self.max_depth or node.support < 2 * self.min_leaf or len(node.counts) < 2:
            return
        best = None
        for f in self.features:
            s = self._best_split(node, f)
            if s and (best is None or s.gain > best.gain):
                best = s
        if best is None or best.gain < self.min_gain:
            return
        left = [i for i in node.indices if best.goes_left(self.X[i])]
        if split_p_value(node.counts, Counter(self.y[i] for i in left)) >= self.alpha:
            return
        right = [i for i in node.indices if not best.goes_left(self.X[i])]
        node.split = best
        node.left = Node(left, node.depth + 1, Counter(self.y[i] for i in left), path=node.path + ".L")
        node.right = Node(right, node.depth + 1, Counter(self.y[i] for i in right), path=node.path + ".R")
        self._grow(node.left)
        self._grow(node.right)

    def _gain(self, parent: Counter, n: int, left: Counter, nl: int) -> float:
        nr = n - nl
        if nl < self.min_leaf or nr < self.min_leaf:
            return -1.0
        right = parent - left
        weighted = (nl * gini(left, nl) + nr * gini(right, nr)) / n
        return (gini(parent, n) - weighted) * n / self.n_root

    def _best_split(self, node: Node, f: Feature) -> Split | None:
        X, y, idx, n = self.X, self.y, node.indices, node.support
        best: Split | None = None
        if f.kind == "numeric":
            rows = sorted((X[i][f.name], y[i]) for i in idx if X[i].get(f.name) is not None)
            if len(rows) < n:   # missing values would make routing ambiguous
                return None
            values = sorted({v for v, _ in rows})
            if len(values) < 2:
                return None
            step = max(1, math.ceil(len(values) / self.max_thresholds))
            candidates = set(values[1::step])
            below = Counter()
            j = 0
            for t in sorted(candidates):
                while j < len(rows) and rows[j][0] < t:
                    below[rows[j][1]] += 1
                    j += 1
                g = self._gain(node.counts, n, node.counts - below, n - j)   # left = ">= t"
                if g > 0 and (best is None or g > best.gain):
                    best = Split(f, int(t) if f.integer else t, g)
        else:
            values = [True] if f.kind == "boolean" else sorted({X[i].get(f.name) for i in idx} - {None})
            for v in values:
                left = Counter(y[i] for i in idx if (bool(X[i].get(f.name)) if f.kind == "boolean" else X[i].get(f.name) == v))
                g = self._gain(node.counts, n, left, sum(left.values()))
                if g > 0 and (best is None or g > best.gain):
                    best = Split(f, v, g)
        return best
