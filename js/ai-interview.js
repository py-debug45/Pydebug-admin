// ai-interview.js — company-pattern Python interview challenge engine.
// Loads after ai-brain.js. No external AI calls: every answer is derived from
// deterministic inputs, every challenge ships a reference solution and a deep
// test suite, and a strict contract validator runs before anything is inserted.
//
// Company tracks are practice heuristics, not claims that a company asked,
// endorsed, or supplied a question. No placement or selection rate is promised.

const AI_INTERVIEW_TRACKS = {
  mixed: {
    label: "Mixed company patterns",
    coaching: "Balance correctness, edge cases, complexity and explanation.",
    note: "A balanced loop across all 28 interview blueprints and core algorithm patterns.",
    weights: {},
  },
  google: {
    label: "Google-style pattern track",
    coaching: "Clarify scale first, then discuss why the complexity fits the constraints.",
    note: "Extra weight on graphs, dynamic programming, windows, search and complexity trade-offs.",
    weights: { graph: 4, "dynamic-programming": 4, "sliding-window": 4, "binary-search": 3, backtracking: 3, "tree-bfs": 3 },
  },
  microsoft: {
    label: "Microsoft-style pattern track",
    coaching: "Explain invariants and object/state design while keeping the implementation clean.",
    note: "Extra weight on data structures, trees, stacks, state design and careful implementation.",
    weights: { oop: 4, stack: 4, "tree-bfs": 4, recursion: 3, matrix: 3, hashing: 2 },
  },
  amazon: {
    label: "Amazon-style pattern track",
    coaching: "Call out operational edge cases, scale and the cost of each design choice.",
    note: "Extra weight on hashing, heaps, greedy choices, intervals and high-scale list processing.",
    weights: { hashing: 4, heap: 4, greedy: 4, sorting: 3, "two-pointers": 3, "prefix-suffix": 3 },
  },
  meta: {
    label: "Meta-style pattern track",
    coaching: "Move from a correct baseline to a fast implementation without losing edge coverage.",
    note: "Extra weight on hashing, graphs, backtracking, windows and tree traversal.",
    weights: { hashing: 4, graph: 4, backtracking: 4, "sliding-window": 3, "tree-bfs": 3, recursion: 2 },
  },
  apple: {
    label: "Apple-style pattern track",
    coaching: "Prioritise correct state transitions, readable code and precise boundary handling.",
    note: "Extra weight on stateful design, matrices, stacks, two pointers and clean abstractions.",
    weights: { oop: 4, matrix: 4, stack: 3, "two-pointers": 3, "sliding-window": 2, sorting: 2 },
  },
};

const AI_INTERVIEW_PATTERN_LABELS = {
  hashing: "Hash Map / Frequency Counting",
  stack: "Stack / State Tracking",
  greedy: "Greedy / One Pass",
  "bit-manipulation": "Bit Manipulation / Math",
  "two-pointers": "Two Pointers",
  "sliding-window": "Sliding Window",
  "prefix-suffix": "Prefix & Suffix Products",
  sorting: "Sorting + Sweep",
  "binary-search": "Binary Search",
  heap: "Heap / Priority Queue",
  graph: "Graph BFS / Topological Sort",
  "dynamic-programming": "Dynamic Programming",
  recursion: "Recursion / Tree DFS",
  "tree-bfs": "Tree Construction + BFS",
  backtracking: "Backtracking",
  matrix: "Matrix Transformation",
  oop: "OOP / Cache Design",
};

const AI_INTERVIEW_DIFFICULTY_MINUTES = { easy: 15, medium: 25, hard: 40 };

// Python literal for a function call. JSON string quoting is valid Python for
// the generated ASCII/Unicode inputs; booleans and null need explicit mapping.
function AI_ivPy(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite test value");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(AI_ivPy).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${AI_ivPy(String(k))}: ${AI_ivPy(v)}`).join(", ")}}`;
  }
  throw new Error("Unsupported test value: " + typeof value);
}

// Match Python's repr/str closely enough for the JSON-compatible values used
// by the judge. Top-level strings use str(); nested strings use repr().
function AI_ivRepr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite expected value");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(new RegExp(quote, "g"), "\\" + quote);
    return quote + escaped + quote;
  }
  if (Array.isArray(value)) return `[${value.map(AI_ivRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${AI_ivRepr(String(k))}: ${AI_ivRepr(v)}`).join(", ")}}`;
  }
  throw new Error("Unsupported expected value: " + typeof value);
}

function AI_ivStr(value) {
  return typeof value === "string" ? value : AI_ivRepr(value);
}

// Numeric/string array ordering used by Python's list comparisons. JSON
// string sorting is not equivalent (for example, [10] must sort after [2]).
function AI_ivLexCompare(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = AI_ivLexCompare(a[i], b[i]);
      if (order) return order;
    }
    return a.length - b.length;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function AI_ivChallenge(spec) {
  const testCases = [];
  const seenCalls = new Set();
  for (const args of spec.cases) {
    if (!Array.isArray(args)) throw new Error(`${spec.title}: each case must be an argument array`);
    const call = `solve(${args.map(AI_ivPy).join(", ")})`;
    // A random sample can coincide with a fixed edge case. Keep the first
    // occurrence so samples remain stable and never insert duplicate tests.
    if (seenCalls.has(call)) continue;
    seenCalls.add(call);
    testCases.push({ call, expected: AI_ivStr(spec.oracle(...args)) });
  }
  const samples = testCases.slice(0, 2);
  const timeTarget = spec.time;
  const spaceTarget = spec.space;
  const description = [
    spec.prompt,
    "",
    "FUNCTION CONTRACT",
    `Implement solve(${spec.params}). ${spec.contract}`,
    "",
    "EXAMPLES",
    ...samples.map((t, i) => `${i + 1}. ${t.call}  →  ${t.expected}`),
    "",
    "CONSTRAINTS",
    ...spec.constraints.map((line) => `• ${line}`),
    "",
    "INTERVIEW TARGET",
    `• Core pattern: ${AI_INTERVIEW_PATTERN_LABELS[spec.pattern]}`,
    `• Suggested time: ${AI_INTERVIEW_DIFFICULTY_MINUTES[spec.difficulty]} minutes`,
    `• Target time complexity: ${timeTarget}`,
    `• Target auxiliary space: ${spaceTarget}`,
    "• Explain your approach before coding and test the boundaries after coding.",
    "",
    "INTERVIEWER FOLLOW-UPS",
    ...spec.followups.map((line, i) => `${i + 1}. ${line}`),
  ].join("\n");
  const starter = `def solve(${spec.params}):\n    """${spec.contract}"""\n    # Write your solution here. Do not print the answer; return it.\n    pass`;
  return {
    type: "coding",
    title: spec.title,
    description,
    difficulty: spec.difficulty,
    topic: spec.topic,
    pattern: spec.pattern,
    pattern_label: AI_INTERVIEW_PATTERN_LABELS[spec.pattern],
    starter_code: starter,
    solution_code: spec.solution.trim(),
    expected_output: testCases[0].expected,
    test_cases: testCases,
    hints: spec.hints,
    constraints: spec.constraints,
    edge_cases: spec.edgeCases,
    followups: spec.followups,
    time_target: timeTarget,
    space_target: spaceTarget,
    public_test_count: samples.length,
    proof: `${testCases.length} expected answers computed from deterministic inputs by the ${spec.oracleName} oracle; independent Python reference included.`,
    rubric: [
      { label: "Correctness", weight: 40, detail: "Passes samples and the full functional test suite." },
      { label: "Edge cases", weight: 20, detail: "Handles empty, duplicate, negative and boundary inputs where applicable." },
      { label: "Complexity", weight: 25, detail: `Meets ${timeTarget} time and ${spaceTarget} auxiliary-space targets.` },
      { label: "Communication", weight: 15, detail: "Explains the invariant, trade-offs and follow-up answers clearly." },
    ],
  };
}

// Each make() creates a complete Write-Code challenge. Cases contain inputs
// only; expected answers are always calculated by an independent JS oracle.
const AI_INTERVIEW_TEMPLATES = [
  {
    id: "interview-pair-with-target", topic: "dictionaries", pattern: "hashing", difficulty: "easy",
    make() {
      const nums = [AI_ri(2, 8), AI_ri(9, 14), AI_ri(1, 6), AI_ri(15, 25)];
      return AI_ivChallenge({
        title: "Pair With Target — Transaction Matching", topic: "dictionaries", pattern: "hashing", difficulty: "easy",
        prompt: "A reconciliation service needs to match two distinct transactions to a target total. Return their indexes without reusing one transaction.",
        params: "nums, target", contract: "Return the two indexes as [i, j] with i < j, or [] when no pair exists. Tests contain at most one valid pair.",
        constraints: ["1 ≤ len(nums) ≤ 100,000; a single-item list simply has no pair.", "Values and target may be negative.", "The same index cannot be used twice; duplicate values are allowed."],
        cases: [[nums, nums[0] + nums[2]], [[2, 7, 11, 15], 9], [[3, 2, 4], 6], [[3, 3], 6], [[1, 5, 2, 8], 10], [[-1, -2, -3, -4], -7], [[0, 4, 3, 0], 0], [[1, 2, 3], 20], [[7], 7]],
        oracle(nums, target) { for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) if (nums[i] + nums[j] === target) return [i, j]; return []; },
        oracleName: "nested-pair", time: "O(n)", space: "O(n)",
        solution: `def solve(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        needed = target - value
        if needed in seen:
            return [seen[needed], index]
        if value not in seen:
            seen[value] = index
    return []`,
        hints: ["A nested loop works for tiny inputs, but what information can you remember while scanning once?", "For value x, the only partner that matters is target - x.", "Store value → earliest index in a dictionary and check the complement before inserting the current value."],
        edgeCases: ["No matching pair", "Negative values", "Duplicate values that must use different indexes"],
        followups: ["How would you return every unique pair when duplicates are present?", "What changes if the input is a stream too large for memory?"],
      });
    },
  },
  {
    id: "interview-valid-brackets", topic: "strings", pattern: "stack", difficulty: "easy",
    make() {
      const sample = AI_pick(["([{}])", "{[()()]}", "(([]))", "[]{()}"]);
      return AI_ivChallenge({
        title: "Valid Brackets — Parser Health Check", topic: "strings", pattern: "stack", difficulty: "easy",
        prompt: "A lightweight configuration parser accepts (), [] and {}. Decide whether every bracket closes in the correct order.",
        params: "s", contract: "Return True when the bracket string is valid and False otherwise. An empty string is valid.",
        constraints: ["0 ≤ len(s) ≤ 100,000.", "s contains only bracket characters for the main judge.", "A closing bracket must match the most recent unmatched opening bracket."],
        cases: [[sample], ["()"], ["][((("], ["()[]{}"], ["(]"], ["([)]"], [""], ["{"], ["((((()))))"], ["][]["], ["{[()]([])}"], ["((()))"]],
        oracle(s) { const stack = [], pairs = { ")": "(", "]": "[", "}": "{" }; for (const ch of s) { if (["(", "[", "{"].includes(ch)) stack.push(ch); else if (stack.pop() !== pairs[ch]) return false; } return stack.length === 0; },
        oracleName: "explicit-stack", time: "O(n)", space: "O(n)",
        solution: `def solve(s):
    pairs = {')': '(', ']': '[', '}': '{'}
    stack = []
    for char in s:
        if char in pairs.values():
            stack.append(char)
        elif char in pairs:
            if not stack or stack.pop() != pairs[char]:
                return False
    return not stack`,
        hints: ["The most recent opening bracket must be handled first; which data structure gives that order?", "Push opening brackets. For a closing bracket, compare it with the top instead of only counting brackets.", "Use a closing → opening mapping, reject a mismatch immediately, and finally check that the stack is empty."],
        edgeCases: ["Empty input", "Closing bracket before any opener", "Correct pairs in the wrong nesting order"],
        followups: ["How would you ignore brackets inside quoted text?", "Can you report the index of the first invalid character?"],
      });
    },
  },
  {
    id: "interview-best-stock-profit", topic: "lists", pattern: "greedy", difficulty: "easy",
    make() {
      const sample = [AI_ri(7, 12), AI_ri(1, 6), AI_ri(3, 8), AI_ri(10, 16), AI_ri(2, 7), AI_ri(12, 20)];
      return AI_ivChallenge({
        title: "Best Single Trade — Maximum Profit", topic: "lists", pattern: "greedy", difficulty: "easy",
        prompt: "Given daily prices, choose at most one buy followed by one sell. The service must also behave safely when prices never rise.",
        params: "prices", contract: "Return the maximum non-negative profit from one buy and a later sell. Return 0 if no profitable trade exists.",
        constraints: ["0 ≤ len(prices) ≤ 100,000.", "Prices are non-negative integers.", "Buying and selling on the same day is not allowed."],
        cases: [[sample], [[7, 1, 5, 3, 6, 4]], [[7, 6, 4, 3, 1]], [[1, 2, 3, 4, 5]], [[]], [[5]], [[2, 4, 1]], [[3, 3, 3]], [[2, 1, 2, 0, 4]], [[0, 0, 1]]],
        oracle(prices) { let best = 0; for (let buy = 0; buy < prices.length; buy++) for (let sell = buy + 1; sell < prices.length; sell++) best = Math.max(best, prices[sell] - prices[buy]); return best; },
        oracleName: "all-buy-sell-pairs", time: "O(n)", space: "O(1)",
        solution: `def solve(prices):
    minimum = None
    best = 0
    for price in prices:
        if minimum is None or price < minimum:
            minimum = price
        else:
            best = max(best, price - minimum)
    return best`,
        hints: ["For each selling day, which earlier buying price gives the best possible profit?", "Track the minimum price seen so far while scanning left to right.", "Update the minimum first, then compare the current price minus that minimum with the best answer."],
        edgeCases: ["Empty or single-day input", "Strictly falling prices", "A lower price after an earlier profitable window"],
        followups: ["How does the solution change for unlimited transactions?", "How would you return the buy and sell days as well as profit?"],
      });
    },
  },
  {
    id: "interview-first-unique-char", topic: "strings", pattern: "hashing", difficulty: "easy",
    make() {
      const sample = AI_pick(["pydebug", "interview", "levelorder", "aabbccdde"]);
      return AI_ivChallenge({
        title: "First Unique Character — Event Stream", topic: "strings", pattern: "hashing", difficulty: "easy",
        prompt: "Find the first event code that occurs exactly once. Returning -1 for an all-repeated stream is part of the contract.",
        params: "s", contract: "Return the zero-based index of the first non-repeating character, or -1 if none exists.",
        constraints: ["0 ≤ len(s) ≤ 100,000.", "The generated judge uses lowercase English letters.", "Return the earliest index, not the alphabetically first unique character."],
        cases: [[sample], ["leetcode"], ["loveleetcode"], ["aabb"], [""], ["z"], ["aabbccd"], ["abcabcde"], ["rrrabcab"], ["xxyyzzw"], ["ababababa"]],
        oracle(s) { const counts = {}; for (const ch of s) counts[ch] = (counts[ch] || 0) + 1; for (let i = 0; i < s.length; i++) if (counts[s[i]] === 1) return i; return -1; },
        oracleName: "frequency-then-scan", time: "O(n)", space: "O(k), where k is the alphabet size",
        solution: `def solve(s):
    counts = {}
    for char in s:
        counts[char] = counts.get(char, 0) + 1
    for index, char in enumerate(s):
        if counts[char] == 1:
            return index
    return -1`,
        hints: ["One scan cannot know that a character will repeat later, so split the work into two phases.", "Count every character first, then scan the original string again in order.", "A dictionary gives counts; return the first index whose count is exactly 1."],
        edgeCases: ["Empty string", "Every character repeats", "The only unique character is at the end"],
        followups: ["How would you answer this query online as characters arrive?", "What changes for a very large Unicode alphabet?"],
      });
    },
  },
  {
    id: "interview-missing-number", topic: "lists", pattern: "bit-manipulation", difficulty: "easy",
    make() {
      const n = AI_ri(5, 9), missing = AI_ri(0, n);
      const nums = AI_shuffle(Array.from({ length: n + 1 }, (_, i) => i).filter((v) => v !== missing));
      return AI_ivChallenge({
        title: "Missing Number — Sequence Audit", topic: "lists", pattern: "bit-manipulation", difficulty: "easy",
        prompt: "A sequence should contain every value from 0 through n, but exactly one value disappeared during ingestion.",
        params: "nums", contract: "Return the one missing number. The input has n values drawn from the range [0, n] with no duplicates.",
        constraints: ["1 ≤ len(nums) ≤ 100,000.", "Every present value is unique and lies in [0, len(nums)].", "The missing value can be 0 or n."],
        cases: [[nums], [[3, 0, 1]], [[0, 1]], [[1]], [[0]], [[1, 0]], [[2, 0, 1]], [[0, 2, 3, 1]], [[4, 3, 2, 1, 0]], [[9, 6, 4, 2, 3, 5, 7, 0, 1]]],
        oracle(nums) { const n = nums.length; return (n * (n + 1)) / 2 - nums.reduce((a, b) => a + b, 0); },
        oracleName: "range-sum", time: "O(n)", space: "O(1)",
        solution: `def solve(nums):
    answer = len(nums)
    for index, value in enumerate(nums):
        answer ^= index ^ value
    return answer`,
        hints: ["Sorting is unnecessary. Can the expected total be compared with the actual total?", "The sum formula works; XOR is another way to cancel values that appear twice.", "XOR every index and value, then include len(nums) so the final uncancelled value is the answer."],
        edgeCases: ["0 is missing", "n is missing", "The input is shuffled"],
        followups: ["How would you avoid integer overflow in a fixed-width language?", "What changes if two numbers are missing?"],
      });
    },
  },
  {
    id: "interview-merge-sorted", topic: "lists", pattern: "two-pointers", difficulty: "easy",
    make() {
      const a = Array.from({ length: 4 }, () => AI_ri(0, 20)).sort((x, y) => x - y);
      const b = Array.from({ length: 3 }, () => AI_ri(5, 25)).sort((x, y) => x - y);
      return AI_ivChallenge({
        title: "Merge Sorted Streams — Without Re-sorting", topic: "lists", pattern: "two-pointers", difficulty: "easy",
        prompt: "Two already-sorted event batches must become one sorted batch. Preserve duplicates and avoid an expensive full re-sort.",
        params: "left, right", contract: "Return one ascending list containing every value from both inputs, including duplicates.",
        constraints: ["Each input is sorted in non-decreasing order.", "0 ≤ len(left), len(right) ≤ 100,000.", "Values may be negative or repeated."],
        cases: [[a, b], [[1, 2, 4], [1, 3, 4]], [[], [1, 2]], [[1, 2], []], [[], []], [[-5, -1, 2], [-3, 0, 2]], [[1, 1, 1], [1, 1]], [[0], [-1]], [[2, 4, 6], [1, 3, 5, 7]], [[5, 5, 6], [4]]],
        oracle(left, right) { return [...left, ...right].sort((a, b) => a - b); },
        oracleName: "concatenate-and-sort", time: "O(n + m)", space: "O(n + m) for the returned list",
        solution: `def solve(left, right):
    merged = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i])
            i += 1
        else:
            merged.append(right[j])
            j += 1
    merged.extend(left[i:])
    merged.extend(right[j:])
    return merged`,
        hints: ["The smallest remaining value must be at the front of one of the two inputs.", "Keep one index per list and repeatedly append the smaller front value.", "When one list is exhausted, extend the answer with the entire untouched tail of the other list."],
        edgeCases: ["One or both inputs empty", "Duplicates across both lists", "All values in one list precede the other"],
        followups: ["How would you merge k sorted lists efficiently?", "Can this become a lazy generator for streaming input?"],
      });
    },
  },
  {
    id: "interview-tree-max-depth", topic: "recursion", pattern: "recursion", difficulty: "easy",
    make() {
      const sample = AI_pick([[3, 9, 20, null, null, 15, 7], [1, 2, 3, 4, null, null, 5], [1, null, 2, null, 3]]);
      return AI_ivChallenge({
        title: "Maximum Tree Depth — Level-Order Input", topic: "recursion", pattern: "recursion", difficulty: "easy",
        prompt: "A binary tree arrives as a level-order list where None marks a missing child. Measure its longest root-to-leaf path.",
        params: "values", contract: "Build the level-order binary tree and return its maximum depth. An empty tree has depth 0; a root-only tree has depth 1.",
        constraints: ["0 ≤ number of nodes ≤ 10,000.", "None entries represent absent children in standard compact level order.", "The tree can be completely skewed."],
        cases: [[sample], [[]], [[1]], [[3, 9, 20, null, null, 15, 7]], [[1, 2, null, 3, null, 4]], [[1, null, 2, null, 3]], [[1, 2, 3, 4, 5, 6, 7]], [[1, 2, 3, null, 4, 5]], [[0, -1, 1]], [[1, 2, 2, 3, null, null, 3, 4]]],
        oracle(values) {
          if (!values.length || values[0] === null) return 0;
          const root = { v: values[0], l: null, r: null }, queue = [root]; let i = 1;
          for (let q = 0; q < queue.length && i < values.length; q++) {
            const node = queue[q];
            if (i < values.length) { if (values[i] !== null) { node.l = { v: values[i], l: null, r: null }; queue.push(node.l); } i++; }
            if (i < values.length) { if (values[i] !== null) { node.r = { v: values[i], l: null, r: null }; queue.push(node.r); } i++; }
          }
          const depth = (node) => node ? 1 + Math.max(depth(node.l), depth(node.r)) : 0; return depth(root);
        },
        oracleName: "tree-build-and-dfs", time: "O(n)", space: "O(n) for tree construction + O(h) recursion",
        solution: `def solve(values):
    if not values or values[0] is None:
        return 0
    nodes = []
    root = [values[0], None, None]
    nodes.append(root)
    index = 1
    cursor = 0
    while cursor < len(nodes) and index < len(values):
        parent = nodes[cursor]
        cursor += 1
        for side in (1, 2):
            if index >= len(values):
                break
            if values[index] is not None:
                child = [values[index], None, None]
                parent[side] = child
                nodes.append(child)
            index += 1
    def depth(node):
        if node is None:
            return 0
        return 1 + max(depth(node[1]), depth(node[2]))
    return depth(root)`,
        hints: ["First reconstruct parent-child links by consuming the level-order list with a queue.", "The depth of an empty subtree is 0; otherwise it is 1 plus the deeper child.", "Use recursive DFS for depth, and an iterative queue while building to avoid mixing the two phases."],
        edgeCases: ["Empty tree", "Root-only tree", "Left- or right-skewed tree"],
        followups: ["How would you avoid recursion limits on a very skewed tree?", "Can you determine whether the same tree is height-balanced?"],
      });
    },
  },
  {
    id: "interview-longest-unique-window", topic: "strings", pattern: "sliding-window", difficulty: "medium",
    make() {
      const sample = AI_pick(["aabca", "pwwkew", "dvdf", "abba", "tmmzuxt"]);
      return AI_ivChallenge({
        title: "Longest Unique Window — Streaming Text", topic: "strings", pattern: "sliding-window", difficulty: "medium",
        prompt: "Find the longest contiguous substring that contains no repeated character. Contiguity is essential; a subsequence is not enough.",
        params: "s", contract: "Return the length of the longest substring without repeating characters.",
        constraints: ["0 ≤ len(s) ≤ 100,000.", "The generated judge uses lowercase English letters.", "The answer is a length, not the substring itself."],
        cases: [[sample], ["abcabcbb"], ["bbbbb"], [""], ["abcdef"], ["abba"], ["dvdf"], ["pwwkew"], ["a"], ["au"], ["anviaj"], ["abcdeafgh"]],
        oracle(s) { let best = 0; for (let i = 0; i < s.length; i++) { const seen = new Set(); for (let j = i; j < s.length && !seen.has(s[j]); j++) { seen.add(s[j]); best = Math.max(best, j - i + 1); } } return best; },
        oracleName: "all-start-positions", time: "O(n)", space: "O(k), where k is the alphabet size",
        solution: `def solve(s):
    last_seen = {}
    left = 0
    best = 0
    for right, char in enumerate(s):
        if char in last_seen and last_seen[char] >= left:
            left = last_seen[char] + 1
        last_seen[char] = right
        best = max(best, right - left + 1)
    return best`,
        hints: ["When a character repeats, you do not need to restart from every possible position.", "Maintain a valid [left, right] window and the most recent index of each character.", "Move left only when the previous occurrence is inside the current window; never move it backwards."],
        edgeCases: ["Empty or single-character input", "All characters identical", "A repeated character outside the active window"],
        followups: ["How would you return the actual substring as well?", "What changes when at most k repeats are allowed?"],
      });
    },
  },
  {
    id: "interview-group-anagrams", topic: "dictionaries", pattern: "hashing", difficulty: "medium",
    make() {
      const sample = AI_pick([["eat", "tea", "tan", "ate", "nat", "bat"], ["arc", "car", "rat", "art", "tar"], ["one", "eon", "two", "tow", "neo"]]);
      return AI_ivChallenge({
        title: "Group Anagrams — Canonical Keys", topic: "dictionaries", pattern: "hashing", difficulty: "medium",
        prompt: "Group words that contain the same character frequencies. The output is canonicalised so judge results do not depend on dictionary order.",
        params: "words", contract: "Return anagram groups. Sort each group alphabetically, then sort groups by their first word (and length for determinism).",
        constraints: ["0 ≤ len(words) ≤ 10,000.", "Words contain lowercase English letters and may be empty.", "Every input word must appear in exactly one output group."],
        cases: [[sample], [["eat", "tea", "tan", "ate", "nat", "bat"]], [[]], [[""]], [["", ""]], [["a", "b", "a"]], [["abc", "bca", "cab", "abcd"]], [["listen", "silent", "enlist", "hello"]], [["aa", "a", "aaa"]], [["stop", "pots", "tops", "spot"]], [["ab", "ba", "abc", "bca", "cba"]]],
        oracle(words) { const groups = {}; for (const word of words) { const key = [...word].sort().join(""); (groups[key] ||= []).push(word); } return Object.values(groups).map((g) => [...g].sort()).sort((a, b) => (a[0] || "").localeCompare(b[0] || "") || a.length - b.length); },
        oracleName: "sorted-character-key", time: "O(Σ L log L + N log N), including canonical output ordering", space: "O(total characters)",
        solution: `def solve(words):
    groups = {}
    for word in words:
        key = ''.join(sorted(word))
        groups.setdefault(key, []).append(word)
    answer = [sorted(group) for group in groups.values()]
    return sorted(answer, key=lambda group: (group[0], len(group)))`,
        hints: ["Two anagrams need a shared representation that is independent of character order.", "Sorting each word creates a canonical dictionary key; character-frequency tuples are another option.", "Group first, then normalise both the inside and outside ordering exactly as the contract requests."],
        edgeCases: ["Empty input and empty words", "No anagram pairs", "Same letters with different frequencies"],
        followups: ["How can you avoid sorting every word?", "Which key is better when the alphabet is large but word lengths are small?"],
      });
    },
  },
  {
    id: "interview-product-except-self", topic: "lists", pattern: "prefix-suffix", difficulty: "medium",
    make() {
      const sample = Array.from({ length: 5 }, () => AI_ri(1, 6));
      return AI_ivChallenge({
        title: "Product Except Self — No Division", topic: "lists", pattern: "prefix-suffix", difficulty: "medium",
        prompt: "Build per-position products without using division. Zero-heavy cases are intentional and must not cause a crash.",
        params: "nums", contract: "Return answer[i] equal to the product of every nums[j] where j ≠ i, without using division.",
        constraints: ["2 ≤ len(nums) ≤ 100,000 for the conceptual limit.", "Values may be zero or negative.", "The output array does not count as auxiliary space for the target."],
        cases: [[sample], [[1, 2, 3, 4]], [[-1, 1, 0, -3, 3]], [[0, 0, 1, 2]], [[2, 3]], [[1, 1, 1, 1]], [[-2, -3, -4]], [[0, 4, 5]], [[2, 0, 3, 0]], [[-1, -2, 3, 4]]],
        oracle(nums) { return nums.map((_, i) => nums.reduce((p, v, j) => i === j ? p : p * v, 1)); },
        oracleName: "product-per-index", time: "O(n)", space: "O(1) auxiliary, excluding the output",
        solution: `def solve(nums):
    answer = [1] * len(nums)
    prefix = 1
    for index, value in enumerate(nums):
        answer[index] = prefix
        prefix *= value
    suffix = 1
    for index in range(len(nums) - 1, -1, -1):
        answer[index] *= suffix
        suffix *= nums[index]
    return answer`,
        hints: ["For each index, the answer is the product on its left multiplied by the product on its right.", "First store all left products in the output. Then scan backwards with one running right product.", "Do not special-case zeros; the prefix/suffix method naturally handles one or many zeros."],
        edgeCases: ["One zero", "Multiple zeros", "Negative values and minimum-length input"],
        followups: ["Why does division-based multiplication fail on zeroes?", "Can you derive a logarithmic-time approach using division when zeroes are absent?"],
      });
    },
  },
  {
    id: "interview-container-water", topic: "lists", pattern: "two-pointers", difficulty: "medium",
    make() {
      const sample = Array.from({ length: 7 }, () => AI_ri(0, 12));
      return AI_ivChallenge({
        title: "Container With Most Water — Boundary Optimisation", topic: "lists", pattern: "two-pointers", difficulty: "medium",
        prompt: "Vertical lines form a container with the x-axis. Find the largest area using two lines, where height is limited by the shorter line.",
        params: "heights", contract: "Return max((j - i) × min(heights[i], heights[j])) over all i < j. Return 0 when fewer than two lines exist.",
        constraints: ["0 ≤ len(heights) ≤ 100,000.", "Heights are non-negative integers.", "The container cannot be slanted; width is the index distance."],
        cases: [[sample], [[1, 8, 6, 2, 5, 4, 8, 3, 7]], [[1, 1]], [[]], [[4]], [[0, 0, 0]], [[1, 2, 1]], [[1, 3, 2, 5, 25, 24, 5]], [[5, 4, 3, 2, 1]], [[1, 2, 4, 3]], [[0, 10, 0]]],
        oracle(heights) { let best = 0; for (let i = 0; i < heights.length; i++) for (let j = i + 1; j < heights.length; j++) best = Math.max(best, (j - i) * Math.min(heights[i], heights[j])); return best; },
        oracleName: "all-boundary-pairs", time: "O(n)", space: "O(1)",
        solution: `def solve(heights):
    left, right = 0, len(heights) - 1
    best = 0
    while left < right:
        best = max(best, (right - left) * min(heights[left], heights[right]))
        if heights[left] <= heights[right]:
            left += 1
        else:
            right -= 1
    return best`,
        hints: ["Start with the widest possible container, then decide which boundary is worth changing.", "Moving the taller boundary cannot improve the limiting height while width gets smaller.", "Move the shorter side (move left when heights are equal) and update the area before every move."],
        edgeCases: ["Fewer than two lines", "Zero-height boundaries", "Equal heights and monotonic input"],
        followups: ["Prove why discarding the shorter boundary is safe.", "How is this different from trapping rain water?"],
      });
    },
  },
  {
    id: "interview-three-sum", topic: "sorting", pattern: "two-pointers", difficulty: "medium",
    make() {
      const sample = AI_pick([[-1, 0, 1, 2, -1, -4], [-2, 0, 1, 1, 2], [-3, -1, 0, 1, 2, 4], [0, 0, 0, 1, -1, 2]]);
      return AI_ivChallenge({
        title: "Three Sum — Unique Triplets", topic: "sorting", pattern: "two-pointers", difficulty: "medium",
        prompt: "Find every distinct triplet whose sum is zero. Duplicate values in the input must not create duplicate triplets in the answer.",
        params: "nums", contract: "Return unique [a, b, c] triplets with a + b + c = 0. Sort each triplet and sort the outer list lexicographically.",
        constraints: ["0 ≤ len(nums) ≤ 3,000 for the conceptual limit.", "Values may be negative, zero or repeated.", "Triplets must use three different indexes, but equal values are allowed."],
        cases: [[sample], [[-1, 0, 1, 2, -1, -4]], [[]], [[0]], [[0, 0, 0]], [[0, 0, 0, 0]], [[1, 2, 3]], [[-2, 0, 1, 1, 2]], [[-4, -1, -1, 0, 1, 2]], [[3, 0, -2, -1, 1, 2]], [[-1, 0, 1]], [[-5, 2, 3, 0, 1, -1]]],
        oracle(nums) { const found = new Set(); for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) for (let k = j + 1; k < nums.length; k++) if (nums[i] + nums[j] + nums[k] === 0) found.add(JSON.stringify([nums[i], nums[j], nums[k]].sort((a, b) => a - b))); return [...found].map(JSON.parse).sort(AI_ivLexCompare); },
        oracleName: "all-index-triples", time: "O(n²)", space: "O(n) for the sorted copy, excluding the output",
        solution: `def solve(nums):
    nums = sorted(nums)
    answer = []
    for i in range(len(nums) - 2):
        if i and nums[i] == nums[i - 1]:
            continue
        left, right = i + 1, len(nums) - 1
        while left < right:
            total = nums[i] + nums[left] + nums[right]
            if total < 0:
                left += 1
            elif total > 0:
                right -= 1
            else:
                answer.append([nums[i], nums[left], nums[right]])
                left += 1
                right -= 1
                while left < right and nums[left] == nums[left - 1]:
                    left += 1
                while left < right and nums[right] == nums[right + 1]:
                    right -= 1
    return answer`,
        hints: ["Sort first so duplicate values become adjacent and a sum can guide pointer movement.", "Fix one index, then solve a two-sum problem on the remaining sorted range with two pointers.", "Skip duplicate fixed values and, after recording a triplet, skip duplicate left and right values too."],
        edgeCases: ["Fewer than three values", "All zeroes", "Several duplicate routes to the same triplet"],
        followups: ["How would you return triplets closest to a target instead?", "Where does the O(n²) complexity come from?"],
      });
    },
  },
  {
    id: "interview-merge-intervals", topic: "sorting", pattern: "sorting", difficulty: "medium",
    make() {
      const sample = AI_pick([[[1, 3], [2, 6], [8, 10], [15, 18]], [[1, 4], [4, 5]], [[1, 4], [0, 2], [3, 5]], [[6, 8], [1, 9], [2, 4]]]);
      return AI_ivChallenge({
        title: "Merge Intervals — Scheduling Overlap", topic: "sorting", pattern: "sorting", difficulty: "medium",
        prompt: "Consolidate overlapping calendar intervals. Touching intervals such as [1, 4] and [4, 5] should also merge.",
        params: "intervals", contract: "Return the minimum list of non-overlapping closed intervals covering the same ranges, sorted by start time.",
        constraints: ["0 ≤ len(intervals) ≤ 100,000.", "Each interval is [start, end] with start ≤ end.", "Input order is arbitrary; endpoints may be negative or repeated."],
        cases: [[sample], [[[1, 3], [2, 6], [8, 10], [15, 18]]], [[]], [[[1, 4]]], [[[1, 4], [4, 5]]], [[[1, 4], [0, 4]]], [[[1, 4], [2, 3]]], [[[5, 6], [1, 2], [3, 4]]], [[[-3, -1], [-2, 0], [2, 3]]], [[[1, 10], [2, 3], [4, 5], [6, 7]]], [[[1, 1], [1, 1], [2, 2]]]],
        oracle(intervals) { const sorted = intervals.map((x) => [...x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), out = []; for (const iv of sorted) { if (!out.length || iv[0] > out[out.length - 1][1]) out.push(iv); else out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]); } return out; },
        oracleName: "sort-and-sweep", time: "O(n log n)", space: "O(n) for sorted input/output",
        solution: `def solve(intervals):
    ordered = sorted(intervals)
    merged = []
    for start, end in ordered:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return merged`,
        hints: ["Unsorted intervals hide adjacency; choose an ordering that makes overlaps local.", "Sort by start time and compare each interval only with the last merged interval.", "Merge when start ≤ previous end, and extend with max(previous end, current end) for containment cases."],
        edgeCases: ["Empty input", "One interval fully contains another", "Touching endpoints and unsorted ranges"],
        followups: ["How would you insert one new interval without rebuilding everything?", "When can this be solved in linear time?"],
      });
    },
  },
  {
    id: "interview-rotated-search", topic: "sorting", pattern: "binary-search", difficulty: "medium",
    make() {
      const base = [1, 3, 5, 7, 9, 11], k = AI_ri(1, base.length - 1), nums = [...base.slice(k), ...base.slice(0, k)];
      const target = AI_pick([...base, 8]);
      return AI_ivChallenge({
        title: "Search Rotated Array — Preserve Log Time", topic: "sorting", pattern: "binary-search", difficulty: "medium",
        prompt: "A strictly increasing array was rotated at an unknown pivot. Find the target without scanning every element.",
        params: "nums, target", contract: "Return the target's zero-based index, or -1 if absent. All values are distinct.",
        constraints: ["0 ≤ len(nums) ≤ 100,000.", "The input is one rotation of a strictly ascending array.", "Duplicate values are not present; the target may be absent."],
        cases: [[nums, target], [[4, 5, 6, 7, 0, 1, 2], 0], [[4, 5, 6, 7, 0, 1, 2], 3], [[1], 1], [[1], 0], [[], 5], [[3, 1], 1], [[3, 1], 3], [[5, 6, 1, 2, 3, 4], 2], [[2, 3, 4, 5, 1], 5], [[-3, -1, 0, -8, -5], -8]],
        oracle(nums, target) { return nums.indexOf(target); },
        oracleName: "linear-index", time: "O(log n)", space: "O(1)",
        solution: `def solve(nums, target):
    left, right = 0, len(nums) - 1
    while left <= right:
        mid = (left + right) // 2
        if nums[mid] == target:
            return mid
        if nums[left] <= nums[mid]:
            if nums[left] <= target < nums[mid]:
                right = mid - 1
            else:
                left = mid + 1
        else:
            if nums[mid] < target <= nums[right]:
                left = mid + 1
            else:
                right = mid - 1
    return -1`,
        hints: ["At every midpoint, at least one half is still normally sorted.", "Identify the sorted half, then check whether the target lies inside its inclusive/exclusive boundaries.", "Discard the other half; handle empty input with right = len(nums) - 1 and use left ≤ right."],
        edgeCases: ["Empty or singleton input", "Target outside the value range", "Pivot beside the midpoint"],
        followups: ["Why do duplicate values make the same decision ambiguous?", "How would you find the rotation pivot itself?"],
      });
    },
  },
  {
    id: "interview-kth-largest", topic: "sorting", pattern: "heap", difficulty: "medium",
    make() {
      const sample = Array.from({ length: 7 }, () => AI_ri(-5, 20)), k = AI_ri(1, 4);
      return AI_ivChallenge({
        title: "Kth Largest — Bounded Priority Queue", topic: "sorting", pattern: "heap", difficulty: "medium",
        prompt: "A ranking service needs the kth largest value without sorting the entire stream. Duplicate values count as separate positions.",
        params: "nums, k", contract: "Return the kth largest element (1-based), counting duplicates separately. k is always valid.",
        constraints: ["1 ≤ k ≤ len(nums) ≤ 100,000.", "Values may be negative or repeated.", "The judge expects the value, not its original index."],
        cases: [[sample, k], [[3, 2, 1, 5, 6, 4], 2], [[3, 2, 3, 1, 2, 4, 5, 5, 6], 4], [[1], 1], [[2, 1], 2], [[-1, -2, -3], 1], [[-1, -2, -3], 3], [[5, 5, 5], 2], [[0, 10, 0, 20], 3], [[7, 6, 5, 4, 3, 2, 1], 7]],
        oracle(nums, k) { return [...nums].sort((a, b) => b - a)[k - 1]; },
        oracleName: "descending-sort", time: "O(n log k)", space: "O(k)",
        solution: `def solve(nums, k):
    import heapq
    heap = []
    for value in nums:
        if len(heap) < k:
            heapq.heappush(heap, value)
        elif value > heap[0]:
            heapq.heapreplace(heap, value)
    return heap[0]`,
        hints: ["You only need to remember the best k values, not the complete ordering.", "A min-heap of size k keeps the current kth largest at its root.", "Fill the heap, then replace its root only when a larger value arrives; the final root is the answer."],
        edgeCases: ["k equals 1 or n", "Negative values", "Many duplicates"],
        followups: ["When would Quickselect be preferable?", "How would you support a continuous stream with repeated kth-largest queries?"],
      });
    },
  },
  {
    id: "interview-course-schedule", topic: "dictionaries", pattern: "graph", difficulty: "medium",
    make() {
      const sample = AI_pick([[2, [[1, 0]]], [2, [[1, 0], [0, 1]]], [5, [[1, 0], [2, 1], [3, 1], [4, 3]]], [4, [[1, 0], [2, 0], [3, 1], [3, 2]]]]);
      return AI_ivChallenge({
        title: "Course Schedule — Dependency Cycle Detection", topic: "dictionaries", pattern: "graph", difficulty: "medium",
        prompt: "Each prerequisite [course, before] creates a directed dependency. Decide whether all courses can be completed without a cyclic dependency.",
        params: "numCourses, prerequisites", contract: "Return True if every course can be finished, otherwise False. Courses are numbered 0 through numCourses - 1.",
        constraints: ["0 ≤ numCourses ≤ 10,000 for the conceptual limit.", "A prerequisite pair [a, b] means b must be taken before a.", "Self-dependencies and cycles are possible; duplicate pairs may be included."],
        cases: [[sample[0], sample[1]], [2, [[1, 0]]], [2, [[1, 0], [0, 1]]], [0, []], [3, []], [1, [[0, 0]]], [4, [[1, 0], [2, 1], [3, 2]]], [4, [[1, 0], [2, 1], [1, 2]]], [5, [[1, 0], [2, 0], [3, 1], [4, 2]]], [3, [[0, 1], [0, 1], [2, 0]]], [4, [[0, 3], [1, 3], [2, 3], [3, 0]]]],
        oracle(numCourses, prerequisites) { const graph = Array.from({ length: numCourses }, () => []), indeg = Array(numCourses).fill(0), seen = new Set(); for (const [a, b] of prerequisites) { const key = `${a},${b}`; if (seen.has(key)) continue; seen.add(key); graph[b].push(a); indeg[a]++; } const q = indeg.map((d, i) => d === 0 ? i : -1).filter((i) => i >= 0); let done = 0; for (let h = 0; h < q.length; h++) for (const next of graph[q[h]]) if (--indeg[next] === 0) q.push(next); return q.length === numCourses; },
        oracleName: "topological-sort", time: "O(V + E)", space: "O(V + E)",
        solution: `def solve(numCourses, prerequisites):
    graph = [[] for _ in range(numCourses)]
    indegree = [0] * numCourses
    seen = set()
    for course, before in prerequisites:
        pair = (course, before)
        if pair in seen:
            continue
        seen.add(pair)
        graph[before].append(course)
        indegree[course] += 1
    queue = [course for course in range(numCourses) if indegree[course] == 0]
    head = 0
    while head < len(queue):
        course = queue[head]
        head += 1
        for nxt in graph[course]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    return len(queue) == numCourses`,
        hints: ["A course with no pending prerequisites is safe to take immediately.", "Build indegrees and repeatedly remove zero-indegree courses; this is Kahn's topological-sort algorithm.", "Deduplicate edges so repeated pairs do not inflate indegree, then compare processed courses with numCourses."],
        edgeCases: ["No courses or no prerequisites", "Self-cycle and multi-node cycle", "Duplicate dependency pairs"],
        followups: ["How would you return one valid course order?", "Can you solve it with DFS colouring instead?"],
      });
    },
  },
  {
    id: "interview-number-islands", topic: "lists", pattern: "graph", difficulty: "medium",
    make() {
      const sample = AI_pick([
        [[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]],
        [[1, 0, 1], [0, 1, 0], [1, 0, 1]],
        [[1, 1, 1], [0, 1, 0], [1, 1, 1]],
      ]);
      return AI_ivChallenge({
        title: "Number of Islands — Grid Flood Fill", topic: "lists", pattern: "graph", difficulty: "medium",
        prompt: "A binary map uses 1 for land and 0 for water. Count connected land regions using horizontal and vertical adjacency only.",
        params: "grid", contract: "Return the number of four-directionally connected islands. Diagonal land cells belong to different islands unless connected through land.",
        constraints: ["The grid is rectangular when non-empty; rows may be empty in edge tests.", "Cells contain only 0 or 1.", "Diagonal adjacency does not count."],
        cases: [[sample], [[[1, 1, 1], [0, 1, 0], [1, 1, 1]]], [[]], [[[]]], [[[0, 0], [0, 0]]], [[[1]]], [[[1, 0], [0, 1]]], [[[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]]], [[[1, 0, 1, 0, 1]]], [[[1, 1], [1, 1]]], [[[0, 1, 0], [1, 1, 1], [0, 1, 0]]]],
        oracle(grid) { if (!grid.length || !grid[0].length) return 0; const seen = new Set(); let islands = 0; const R = grid.length, C = grid[0].length; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const key = `${r},${c}`; if (!grid[r][c] || seen.has(key)) continue; islands++; const q = [[r, c]]; seen.add(key); for (let h = 0; h < q.length; h++) { const [x, y] = q[h]; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, k = `${nx},${ny}`; if (nx >= 0 && nx < R && ny >= 0 && ny < C && grid[nx][ny] && !seen.has(k)) { seen.add(k); q.push([nx, ny]); } } } } return islands; },
        oracleName: "breadth-first-flood-fill", time: "O(rows × columns)", space: "O(rows × columns) in the worst case",
        solution: `def solve(grid):
    if not grid or not grid[0]:
        return 0
    rows, cols = len(grid), len(grid[0])
    visited = set()
    islands = 0
    for row in range(rows):
        for col in range(cols):
            if grid[row][col] == 0 or (row, col) in visited:
                continue
            islands += 1
            queue = [(row, col)]
            visited.add((row, col))
            head = 0
            while head < len(queue):
                r, c = queue[head]
                head += 1
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 1 and (nr, nc) not in visited:
                        visited.add((nr, nc))
                        queue.append((nr, nc))
    return islands`,
        hints: ["Every unvisited land cell starts exactly one new island; the rest of that island must be marked.", "Use BFS or DFS over four neighbours and mark cells visited when enqueuing, not only when processing.", "Guard empty grids before reading grid[0], and never add diagonal directions."],
        edgeCases: ["Empty grid or empty row", "All water or all land", "Diagonal-only contact"],
        followups: ["How does in-place marking change the space cost?", "How would you process a grid too large to fit in memory?"],
      });
    },
  },
  {
    id: "interview-coin-change", topic: "recursion", pattern: "dynamic-programming", difficulty: "medium",
    make() {
      const coins = AI_pick([[1, 3, 4], [1, 2, 5], [2, 5, 10], [1, 4, 6]]), amount = AI_ri(6, 18);
      return AI_ivChallenge({
        title: "Coin Change — Minimum Operations", topic: "recursion", pattern: "dynamic-programming", difficulty: "medium",
        prompt: "Given coin denominations, make an amount with as few coins as possible. Unlimited supply and unreachable amounts are both part of the problem.",
        params: "coins, amount", contract: "Return the minimum number of coins needed, or -1 when the amount cannot be formed. Amount 0 needs 0 coins.",
        constraints: ["Denominations are positive and may be unsorted.", "Each denomination can be used unlimited times.", "0 ≤ amount ≤ 10,000 for the conceptual limit; return -1 for unreachable amounts."],
        cases: [[coins, amount], [[1, 2, 5], 11], [[2], 3], [[1], 0], [[2, 5], 0], [[2, 4], 7], [[1, 3, 4], 6], [[5, 2, 1], 11], [[3, 7], 12], [[2, 5, 10], 1], [[1, 2, 3], 7]],
        oracle(coins, amount) { const dp = Array(amount + 1).fill(Infinity); dp[0] = 0; for (let a = 1; a <= amount; a++) for (const c of coins) if (c <= a) dp[a] = Math.min(dp[a], dp[a - c] + 1); return Number.isFinite(dp[amount]) ? dp[amount] : -1; },
        oracleName: "bottom-up-dp", time: "O(amount × number of coins)", space: "O(amount)",
        solution: `def solve(coins, amount):
    unreachable = amount + 1
    dp = [unreachable] * (amount + 1)
    dp[0] = 0
    for current in range(1, amount + 1):
        for coin in coins:
            if coin <= current:
                dp[current] = min(dp[current], dp[current - coin] + 1)
    return -1 if dp[amount] == unreachable else dp[amount]`,
        hints: ["The best answer for an amount depends only on smaller amounts, so repeated subproblems can be cached.", "Let dp[a] be the minimum coins for a. Try every coin and transition from a - coin.", "Initialise unreachable states above any possible answer, set dp[0] = 0, and translate an unreachable final state to -1."],
        edgeCases: ["Amount zero", "Unreachable amount", "Unsorted coins or coins larger than the amount"],
        followups: ["How would you reconstruct the chosen coins?", "How does the problem change when each coin can be used only once?"],
      });
    },
  },
  {
    id: "interview-word-break", topic: "recursion", pattern: "dynamic-programming", difficulty: "medium",
    make() {
      const sample = AI_pick([["leetcode", ["leet", "code"]], ["applepenapple", ["apple", "pen"]], ["catsandog", ["cats", "dog", "sand", "and", "cat"]], ["pydebug", ["py", "debug", "python"]]]);
      return AI_ivChallenge({
        title: "Word Break — Dictionary Segmentation", topic: "recursion", pattern: "dynamic-programming", difficulty: "medium",
        prompt: "Decide whether a string can be segmented entirely into dictionary words. Dictionary entries may be reused and overlaps must be handled.",
        params: "s, wordDict", contract: "Return True if s can be built by concatenating zero or more dictionary words with no leftover characters; otherwise return False.",
        constraints: ["Words may be reused any number of times.", "The generated judge uses lowercase English letters.", "Empty s is segmentable; an empty dictionary cannot segment a non-empty s."],
        cases: [[sample[0], sample[1]], ["leetcode", ["leet", "code"]], ["applepenapple", ["apple", "pen"]], ["catsandog", ["cats", "dog", "sand", "and", "cat"]], ["", ["a"]], ["abc", []], ["aaaa", ["aa", "aaa"]], ["abcd", ["a", "abc", "b", "cd"]], ["cars", ["car", "ca", "rs"]], ["bb", ["a", "b"]], ["aaaaaa", ["aaaa", "aaa"]]],
        oracle(s, wordDict) { const words = new Set(wordDict), dp = Array(s.length + 1).fill(false); dp[0] = true; for (let i = 1; i <= s.length; i++) for (let j = 0; j < i; j++) if (dp[j] && words.has(s.slice(j, i))) { dp[i] = true; break; } return dp[s.length]; },
        oracleName: "prefix-dp", time: "O(n² + total dictionary characters) with a maximum-word-length optimisation", space: "O(n + total dictionary characters)",
        solution: `def solve(s, wordDict):
    words = set(wordDict)
    if not words:
        return not s
    max_length = max(map(len, words))
    reachable = [False] * (len(s) + 1)
    reachable[0] = True
    for end in range(1, len(s) + 1):
        for start in range(max(0, end - max_length), end):
            if reachable[start] and s[start:end] in words:
                reachable[end] = True
                break
    return reachable[-1]`,
        hints: ["A prefix is valid if a smaller valid prefix plus one dictionary word reaches it.", "Use reachable[i] for s[:i], with the empty prefix reachable initially.", "Store words in a set and limit the inner scan to the longest dictionary word to avoid unnecessary substrings."],
        edgeCases: ["Empty string or dictionary", "Overlapping word choices", "A greedy longest-word choice that would fail"],
        followups: ["How would you return every valid segmentation?", "How would a trie improve very large dictionaries?"],
      });
    },
  },
  {
    id: "interview-unique-subsets", topic: "recursion", pattern: "backtracking", difficulty: "medium",
    make() {
      const sample = AI_shuffle([AI_ri(1, 4), AI_ri(5, 8), AI_ri(9, 12)]);
      return AI_ivChallenge({
        title: "Unique Subsets — Backtracking With Duplicates", topic: "recursion", pattern: "backtracking", difficulty: "medium",
        prompt: "Enumerate the power set while ensuring duplicate input values never create duplicate subsets. Canonical output ordering makes every answer judgeable.",
        params: "nums", contract: "Return every unique subset. Sort each subset and sort the outer list lexicographically, including the empty subset.",
        constraints: ["0 ≤ len(nums) ≤ 10 for the conceptual limit.", "Input values may be repeated or negative.", "Each index may be used at most once per subset."],
        cases: [[sample], [[1, 2, 2]], [[]], [[0]], [[1, 2, 3]], [[4, 4, 4, 1, 1]], [[-1, 0, 1]], [[2, 2]], [[3, 2, 1]], [[0, 0, 0]], [[-2, -2, 1]]],
        oracle(nums) { const sorted = [...nums].sort((a, b) => a - b), out = []; function walk(start, path) { out.push([...path]); for (let i = start; i < sorted.length; i++) { if (i > start && sorted[i] === sorted[i - 1]) continue; path.push(sorted[i]); walk(i + 1, path); path.pop(); } } walk(0, []); return out.sort(AI_ivLexCompare); },
        oracleName: "duplicate-skipping-backtracking", time: "O(n × 2ⁿ) including output construction", space: "O(n) recursion stack, excluding output",
        solution: `def solve(nums):
    nums.sort()
    answer = []
    def backtrack(start, path):
        answer.append(path.copy())
        for index in range(start, len(nums)):
            if index > start and nums[index] == nums[index - 1]:
                continue
            path.append(nums[index])
            backtrack(index + 1, path)
            path.pop()
    backtrack(0, [])
    return sorted(answer)`,
        hints: ["At each recursion level, choose the next value and then undo that choice before trying another.", "Sort the input so equal values are adjacent; skip a value when it equals the previous value at the same recursion level.", "Append a copy of the path at every call, then use sorted(answer) for the required canonical ordering."],
        edgeCases: ["Empty input", "Every value identical", "Negative values and unsorted input"],
        followups: ["How would you generate subsets iteratively with bit masks?", "Why must you copy path instead of appending path directly?"],
      });
    },
  },
  {
    id: "interview-rotate-matrix", topic: "lists", pattern: "matrix", difficulty: "medium",
    make() {
      const sample = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, AI_ri(16, 30)]];
      return AI_ivChallenge({
        title: "Rotate Matrix — 90 Degrees Clockwise", topic: "lists", pattern: "matrix", difficulty: "medium",
        prompt: "Rotate a square image matrix by 90 degrees clockwise. The follow-up targets an in-place transformation rather than building a second matrix.",
        params: "matrix", contract: "Return the rotated square matrix. You may mutate the input; an empty matrix returns an empty matrix.",
        constraints: ["The matrix is square: n rows and n columns.", "0 ≤ n ≤ 100 for the conceptual limit.", "Cell values may be negative or repeated."],
        cases: [[sample], [[[1, 2, 3], [4, 5, 6], [7, 8, 9]]], [[]], [[[1]]], [[[1, 2], [3, 4]]], [[[0, -1], [2, -3]]], [[[1, 1], [1, 1]]], [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]], [[[5, 1, 9], [2, 8, 3], [4, 7, 6]]], [[[-1, -2], [-3, -4]]]],
        oracle(matrix) { const n = matrix.length; return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => matrix[n - 1 - c][r])); },
        oracleName: "coordinate-mapping", time: "O(n²)", space: "O(1) auxiliary with in-place rotation",
        solution: `def solve(matrix):
    n = len(matrix)
    for row in range(n):
        for col in range(row + 1, n):
            matrix[row][col], matrix[col][row] = matrix[col][row], matrix[row][col]
    for row in matrix:
        row.reverse()
    return matrix`,
        hints: ["A clockwise rotation maps original bottom-left toward the new top-left; derive the coordinate mapping on a 2×2 example.", "Transposition followed by reversing each row produces a clockwise rotation.", "Swap matrix[r][c] with matrix[c][r] only for c > r, then reverse every row in place."],
        edgeCases: ["Empty and 1×1 matrices", "Repeated values", "Even and odd dimensions"],
        followups: ["How would you rotate anticlockwise?", "How does the approach change for a rectangular matrix?"],
      });
    },
  },
  {
    id: "interview-meeting-rooms", topic: "sorting", pattern: "heap", difficulty: "medium",
    make() {
      const sample = AI_pick([[[0, 30], [5, 10], [15, 20]], [[7, 10], [2, 4], [9, 12]], [[1, 5], [2, 6], [3, 7], [8, 9]], [[1, 10], [2, 7], [3, 19], [8, 12]]]);
      return AI_ivChallenge({
        title: "Minimum Meeting Rooms — Overlap Capacity", topic: "sorting", pattern: "heap", difficulty: "medium",
        prompt: "Allocate the fewest rooms for a meeting schedule. A room becomes available when its meeting ends exactly as another starts.",
        params: "intervals", contract: "Return the minimum number of simultaneous rooms required. For [a, b] and [b, c], the same room can be reused.",
        constraints: ["0 ≤ len(intervals) ≤ 100,000.", "Each interval is [start, end] with start < end; endpoints may be negative.", "Input order is arbitrary."],
        cases: [[sample], [[[0, 30], [5, 10], [15, 20]]], [[]], [[[7, 10], [2, 4]]], [[[1, 4], [4, 5]]], [[[1, 5], [2, 6], [3, 7]]], [[[1, 10], [2, 3], [4, 5]]], [[[9, 10], [4, 9], [4, 17]]], [[[2, 15], [36, 45], [9, 29], [16, 23]]], [[[1, 2], [1, 2], [1, 2]]], [[[-3, 0], [-1, 2]]]],
        oracle(intervals) { const events = []; for (const [s, e] of intervals) { events.push([s, 1]); events.push([e, -1]); } events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let now = 0, best = 0; for (const [, delta] of events) { now += delta; best = Math.max(best, now); } return best; },
        oracleName: "start-end-event-sweep", time: "O(n log n)", space: "O(n)",
        solution: `def solve(intervals):
    import heapq
    endings = []
    rooms = 0
    for start, end in sorted(intervals):
        while endings and endings[0] <= start:
            heapq.heappop(endings)
        heapq.heappush(endings, end)
        rooms = max(rooms, len(endings))
    return rooms`,
        hints: ["When a meeting starts, only the earliest-ending active meeting can be reused first.", "Sort by start time and maintain active end times in a min-heap.", "Remove every end ≤ current start, push the current end, and record the maximum heap size."],
        edgeCases: ["Empty schedule", "Back-to-back meetings", "Nested and identical intervals"],
        followups: ["How would you recover the room assignment for every meeting?", "Can you solve this with start/end event sorting instead?"],
      });
    },
  },
  {
    id: "interview-tree-level-order", topic: "recursion", pattern: "tree-bfs", difficulty: "medium",
    make() {
      const sample = AI_pick([[3, 9, 20, null, null, 15, 7], [1, 2, 3, null, 4, 5], [1, null, 2, 3], [1, 2, 2, 3, 4, 4, 3]]);
      return AI_ivChallenge({
        title: "Binary Tree Level Order — Rebuild and Traverse", topic: "recursion", pattern: "tree-bfs", difficulty: "medium",
        prompt: "Rebuild a binary tree from compact level-order values, then return values grouped by depth from left to right.",
        params: "values", contract: "Return a list of level lists. None marks missing children; an empty tree returns [].",
        constraints: ["0 ≤ number of nodes ≤ 10,000.", "Input uses standard compact level-order representation.", "Values within each level must remain left-to-right."],
        cases: [[sample], [[]], [[1]], [[3, 9, 20, null, null, 15, 7]], [[1, 2, 3, 4, 5]], [[1, null, 2, 3]], [[1, 2, null, 3, null, 4]], [[1, 2, 3, null, 4, 5]], [[0, -1, 1]], [[1, 2, 2, 3, 4, 4, 3]]],
        oracle(values) {
          if (!values.length || values[0] === null) return [];
          const root = { v: values[0], l: null, r: null }, nodes = [root]; let i = 1;
          for (let h = 0; h < nodes.length && i < values.length; h++) { const node = nodes[h]; if (i < values.length) { if (values[i] !== null) { node.l = { v: values[i], l: null, r: null }; nodes.push(node.l); } i++; } if (i < values.length) { if (values[i] !== null) { node.r = { v: values[i], l: null, r: null }; nodes.push(node.r); } i++; } }
          const out = []; for (let level = [root]; level.length;) { out.push(level.map((n) => n.v)); const next = []; for (const n of level) { if (n.l) next.push(n.l); if (n.r) next.push(n.r); } level = next; } return out;
        },
        oracleName: "tree-build-and-level-bfs", time: "O(n)", space: "O(n)",
        solution: `def solve(values):
    if not values or values[0] is None:
        return []
    root = [values[0], None, None]
    nodes = [root]
    index = 1
    head = 0
    while head < len(nodes) and index < len(values):
        parent = nodes[head]
        head += 1
        for side in (1, 2):
            if index >= len(values):
                break
            if values[index] is not None:
                child = [values[index], None, None]
                parent[side] = child
                nodes.append(child)
            index += 1
    answer = []
    level = [root]
    while level:
        answer.append([node[0] for node in level])
        next_level = []
        for node in level:
            if node[1] is not None:
                next_level.append(node[1])
            if node[2] is not None:
                next_level.append(node[2])
        level = next_level
    return answer`,
        hints: ["Tree construction and traversal are separate BFS phases; use a queue for each.", "While building, consume up to two values per parent and enqueue only non-None children.", "While traversing, process one whole level at a time and collect the next level in left-to-right order."],
        edgeCases: ["Empty and root-only trees", "Sparse level-order lists", "Skewed trees"],
        followups: ["How would you return zigzag level order?", "Can you produce right-side view from the same traversal?"],
      });
    },
  },
  {
    id: "interview-minimum-window", topic: "strings", pattern: "sliding-window", difficulty: "hard",
    make() {
      const sample = AI_pick([["ADOBECODEBANC", "ABC"], ["aaabdab", "aab"], ["abdbca", "abc"], ["bba", "ab"]]);
      return AI_ivChallenge({
        title: "Minimum Window Substring — Required Frequencies", topic: "strings", pattern: "sliding-window", difficulty: "hard",
        prompt: "Find the shortest contiguous substring of s covering every character in t, including duplicates. If several shortest windows exist, return the leftmost.",
        params: "s, t", contract: "Return the minimum window from s covering t's character multiplicities. Return an empty string when no window exists.",
        constraints: ["0 ≤ len(s), len(t) ≤ 100,000 for the conceptual limit.", "The generated judge uses English letters; matching is case-sensitive.", "Repeated characters in t must occur at least that many times in the window."],
        cases: [[sample[0], sample[1]], ["ADOBECODEBANC", "ABC"], ["a", "a"], ["a", "aa"], ["", "a"], ["a", ""], ["aaflslflsldkalskaaa", "aaa"], ["ab", "b"], ["bba", "ab"], ["aaabdab", "aab"], ["xyz", "xyz"], ["aa", "aa"]],
        oracle(s, t) { if (!t) return ""; for (let length = t.length; length <= s.length; length++) for (let start = 0; start + length <= s.length; start++) { const window = s.slice(start, start + length); let ok = true; for (const ch of new Set(t)) { let need = 0, have = 0; for (const c of t) if (c === ch) need++; for (const c of window) if (c === ch) have++; if (have < need) { ok = false; break; } } if (ok) return window; } return ""; },
        oracleName: "all-window-lengths", time: "O(len(s) + len(t))", space: "O(k), where k is the alphabet size",
        solution: `def solve(s, t):
    if not t or len(t) > len(s):
        return ''
    required = {}
    for char in t:
        required[char] = required.get(char, 0) + 1
    missing = len(t)
    left = 0
    best_start = 0
    best_length = len(s) + 1
    for right, char in enumerate(s):
        if char in required:
            required[char] -= 1
            if required[char] >= 0:
                missing -= 1
        while missing == 0:
            length = right - left + 1
            if length < best_length:
                best_start, best_length = left, length
            outgoing = s[left]
            if outgoing in required:
                if required[outgoing] >= 0:
                    missing += 1
                required[outgoing] += 1
            left += 1
    return '' if best_length > len(s) else s[best_start:best_start + best_length]`,
        hints: ["Counts matter more than order. Expand until all required occurrences are covered, then shrink from the left.", "Track how many required character occurrences are still missing; it reaches zero only for a valid window.", "When removing a required outgoing character, increase missing if its current count was non-negative; update the answer only on a strictly shorter window."],
        edgeCases: ["t longer than s or no valid window", "Repeated required characters", "Multiple equal-length windows"],
        followups: ["Why is the algorithm linear even with a nested while loop?", "How would you return every minimum-length window?"],
      });
    },
  },
  {
    id: "interview-trapping-rain-water", topic: "lists", pattern: "two-pointers", difficulty: "hard",
    make() {
      const sample = [AI_ri(0, 4), AI_ri(2, 6), AI_ri(0, 2), AI_ri(3, 7), AI_ri(0, 3), AI_ri(2, 5), AI_ri(1, 4)];
      return AI_ivChallenge({
        title: "Trapping Rain Water — Two Boundary Invariants", topic: "lists", pattern: "two-pointers", difficulty: "hard",
        prompt: "An elevation map traps water between bars. Compute the total units after rain without double-counting overlapping containers.",
        params: "heights", contract: "Return the total trapped water above the elevation bars. Heights are non-negative and water is bounded by the tallest bars on both sides.",
        constraints: ["0 ≤ len(heights) ≤ 100,000.", "Heights are non-negative integers.", "Water above a bar is min(max left, max right) - its height when positive."],
        cases: [[sample], [[0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]], [[4, 2, 0, 3, 2, 5]], [[]], [[1]], [[1, 2]], [[0, 0, 0]], [[3, 2, 1]], [[1, 2, 3]], [[2, 0, 2]], [[5, 0, 0, 4, 0, 3]]],
        oracle(heights) { let total = 0; for (let i = 0; i < heights.length; i++) { const left = Math.max(0, ...heights.slice(0, i + 1)), right = Math.max(0, ...heights.slice(i)); total += Math.max(0, Math.min(left, right) - heights[i]); } return total; },
        oracleName: "per-position-boundaries", time: "O(n)", space: "O(1)",
        solution: `def solve(heights):
    left, right = 0, len(heights) - 1
    left_max = right_max = 0
    water = 0
    while left < right:
        if heights[left] < heights[right]:
            if heights[left] >= left_max:
                left_max = heights[left]
            else:
                water += left_max - heights[left]
            left += 1
        else:
            if heights[right] >= right_max:
                right_max = heights[right]
            else:
                water += right_max - heights[right]
            right -= 1
    return water`,
        hints: ["Water at a position depends on the smaller of the highest boundaries to its left and right.", "With two pointers, the side with the smaller current height has a definitive limiting boundary.", "Maintain left_max and right_max; process the lower side and add its max minus its height before moving inward."],
        edgeCases: ["Empty or very short input", "Monotonic elevations", "Zero-height valleys and plateaus"],
        followups: ["Can you solve it with precomputed prefix/suffix maxima?", "How does a monotonic stack approach differ?"],
      });
    },
  },
  {
    id: "interview-lru-cache", topic: "oop", pattern: "oop", difficulty: "hard",
    make() {
      const sample = AI_pick([
        [2, ["put", "put", "get", "put", "get", "put", "get", "get", "get"], [[1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]]],
        [1, ["put", "put", "get", "get"], [[1, 10], [2, 20], [1], [2]]],
        [3, ["put", "put", "put", "get", "put", "get", "get"], [[1, 1], [2, 2], [3, 3], [2], [4, 4], [1], [4]]],
      ]);
      return AI_ivChallenge({
        title: "LRU Cache — Constant-Time State Design", topic: "oop", pattern: "oop", difficulty: "hard",
        prompt: "Simulate a least-recently-used cache from operation logs. Both reads and writes refresh recency, and capacity eviction must be exact.",
        params: "capacity, operations, arguments", contract: "Run put(key, value) and get(key) operations in order and return only get results, using -1 for misses. Updating an existing key also refreshes it.",
        constraints: ["capacity ≥ 1 and both operation arrays have equal length.", "operations[i] is 'put' or 'get'; arguments match that operation.", "Target O(1) average time per operation, not O(capacity)."],
        cases: [[sample[0], sample[1], sample[2]], [2, ["put", "put", "get", "put", "get", "put", "get", "get", "get"], [[1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]]], [1, ["put", "put", "get", "get"], [[1, 10], [2, 20], [1], [2]]], [2, ["get"], [[1]]], [2, ["put", "get"], [[1, 5], [1]]], [2, ["put", "put", "put", "get", "get"], [[1, 1], [2, 2], [3, 3], [1], [2]]], [2, ["put", "get", "put", "get", "get"], [[1, 1], [1], [1, 10], [2], [1]]], [3, ["put", "put", "put", "get", "put", "get", "get"], [[1, 1], [2, 2], [3, 3], [2], [4, 4], [1], [4]]], [1, ["get", "put", "get"], [[0], [0, 0], [0]]], [2, ["put", "put", "get", "get", "put", "get"], [[0, 0], [1, 1], [0], [1], [2, 2], [0]]]],
        oracle(capacity, operations, args) { const cache = new Map(), out = []; for (let i = 0; i < operations.length; i++) { const a = args[i]; if (operations[i] === "put") { cache.delete(a[0]); cache.set(a[0], a[1]); if (cache.size > capacity) cache.delete(cache.keys().next().value); } else { if (!cache.has(a[0])) out.push(-1); else { const v = cache.get(a[0]); cache.delete(a[0]); cache.set(a[0], v); out.push(v); } } } return out; },
        oracleName: "ordered-map-simulation", time: "O(1) average per operation", space: "O(capacity)",
        solution: `def solve(capacity, operations, arguments):
    from collections import OrderedDict
    cache = OrderedDict()
    results = []
    for operation, args in zip(operations, arguments):
        if operation == 'put':
            key, value = args
            cache[key] = value
            cache.move_to_end(key)
            if len(cache) > capacity:
                cache.popitem(last=False)
        else:
            key = args[0]
            if key not in cache:
                results.append(-1)
            else:
                cache.move_to_end(key)
                results.append(cache[key])
    return results`,
        hints: ["Recency changes on both get and put; a normal dictionary lookup alone does not model eviction order.", "Use a hash map plus ordering: OrderedDict supports move_to_end and constant-time eviction of the oldest item.", "On update, move the key to the newest end; after insertion, pop the oldest item when capacity is exceeded."],
        edgeCases: ["Capacity one", "Updating an existing key", "A get that changes which item is evicted next"],
        followups: ["How would you implement OrderedDict behaviour with a doubly linked list and dictionary?", "What additional locking would a concurrent cache need?"],
      });
    },
  },
  {
    id: "interview-longest-valid-parentheses", topic: "strings", pattern: "stack", difficulty: "hard",
    make() {
      const sample = AI_pick(["(()", ")()())", "()(())", "(()())", "())()())"]);
      return AI_ivChallenge({
        title: "Longest Valid Parentheses — Boundary Stack", topic: "strings", pattern: "stack", difficulty: "hard",
        prompt: "Find the longest contiguous well-formed parentheses substring. The answer must be contiguous and can contain multiple adjacent valid sections.",
        params: "s", contract: "Return the maximum length of a valid, contiguous parentheses substring. Return 0 for an empty or invalid-only string.",
        constraints: ["0 ≤ len(s) ≤ 100,000.", "s contains only '(' and ')'.", "The answer is a length; separate valid regions cannot be combined across invalid text."],
        cases: [[sample], ["(()"], [")()())"], [""], ["("], [")"], ["()"], ["()(())"], ["()(()"], [")()())()("], ["((()))"], [")()())"], ["(()()"]],
        oracle(s) { let best = 0; for (let i = 0; i < s.length; i++) { let balance = 0; for (let j = i; j < s.length; j++) { balance += s[j] === "(" ? 1 : -1; if (balance < 0) break; if (balance === 0) best = Math.max(best, j - i + 1); } } return best; },
        oracleName: "all-balanced-substrings", time: "O(n)", space: "O(n)",
        solution: `def solve(s):
    stack = [-1]
    best = 0
    for index, char in enumerate(s):
        if char == '(':
            stack.append(index)
        else:
            stack.pop()
            if not stack:
                stack.append(index)
            else:
                best = max(best, index - stack[-1])
    return best`,
        hints: ["A valid substring ends where its matching opening boundary can be identified; unmatched closing brackets create new boundaries.", "Start a stack with -1. Push opening indexes; on a closing bracket pop once, then measure from the new top.", "If the stack becomes empty after a pop, the closing bracket is unmatched—push its index as the next boundary instead of measuring."],
        edgeCases: ["Empty or all-invalid input", "Adjacent valid sections", "Extra opening brackets after a valid region"],
        followups: ["Can you solve it with O(1) space using left/right counters?", "Why is the initial -1 sentinel necessary?"],
      });
    },
  },
  {
    id: "interview-edit-distance", topic: "recursion", pattern: "dynamic-programming", difficulty: "hard",
    make() {
      const sample = AI_pick([["horse", "ros"], ["intention", "execution"], ["python", "pythons"], ["kitten", "sitting"]]);
      return AI_ivChallenge({
        title: "Edit Distance — Three Operation DP", topic: "recursion", pattern: "dynamic-programming", difficulty: "hard",
        prompt: "Transform one string into another using insertion, deletion and substitution. Each operation costs one, and the minimum sequence matters more than the first greedy match.",
        params: "word1, word2", contract: "Return the Levenshtein distance: the minimum insertions, deletions and substitutions required to transform word1 into word2.",
        constraints: ["0 ≤ len(word1), len(word2) ≤ 1,000 for the conceptual limit.", "The generated judge uses lowercase English letters.", "Both strings may be empty; equal strings have distance 0."],
        cases: [[sample[0], sample[1]], ["horse", "ros"], ["intention", "execution"], ["", "abc"], ["abc", ""], ["", ""], ["same", "same"], ["a", "b"], ["ab", "ba"], ["kitten", "sitting"], ["abc", "yabd"], ["aaa", "a"]],
        oracle(a, b) { const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0)); for (let i = 0; i <= a.length; i++) dp[i][0] = i; for (let j = 0; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]); return dp[a.length][b.length]; },
        oracleName: "full-levenshtein-matrix", time: "O(len(word1) × len(word2))", space: "O(min(len(word1), len(word2)))",
        solution: `def solve(word1, word2):
    if len(word1) < len(word2):
        word1, word2 = word2, word1
    previous = list(range(len(word2) + 1))
    for i, char1 in enumerate(word1, 1):
        current = [i]
        for j, char2 in enumerate(word2, 1):
            if char1 == char2:
                current.append(previous[j - 1])
            else:
                current.append(1 + min(previous[j], current[-1], previous[j - 1]))
        previous = current
    return previous[-1]`,
        hints: ["Define dp[i][j] for the first i and j characters; matching final characters cost nothing, mismatching ones offer three operations.", "Only the previous DP row and the value just computed in the current row are needed.", "Keep the longer string on the outer loop so the stored row is as short as possible, and initialise current with i for deletions."],
        edgeCases: ["One or both strings empty", "Equal strings", "Transpositions that are not a single allowed operation"],
        followups: ["How would you reconstruct the edit operations?", "How does the recurrence change if substitutions cost two?"],
      });
    },
  },
];

function AI_getInterviewLibraryStats() {
  const patterns = new Set(AI_INTERVIEW_TEMPLATES.map((t) => t.pattern));
  const byDifficulty = { easy: 0, medium: 0, hard: 0 };
  AI_INTERVIEW_TEMPLATES.forEach((t) => { byDifficulty[t.difficulty] = (byDifficulty[t.difficulty] || 0) + 1; });
  return { templates: AI_INTERVIEW_TEMPLATES.length, patterns: patterns.size, byDifficulty };
}

function AI_interviewPatternOf(problem) {
  if (problem && AI_INTERVIEW_PATTERN_LABELS[problem.pattern]) return problem.pattern;
  const text = String((problem && problem.description) || "");
  const match = Object.entries(AI_INTERVIEW_PATTERN_LABELS).find(([, label]) => text.includes(`Core pattern: ${label}`));
  return match ? match[0] : "all";
}

function AI_ivTrack(track) {
  return AI_INTERVIEW_TRACKS[track] || AI_INTERVIEW_TRACKS.mixed;
}

function AI_ivWeightedPick(pool, track) {
  const profile = AI_ivTrack(track);
  const weights = pool.map((t) => Math.max(0.1, Number(profile.weights[t.pattern]) || 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function AI_pickInterviewTemplate(opts, excluded) {
  opts = opts || {};
  const difficulty = opts.difficulty || "mixed";
  const pattern = opts.pattern || "all";
  const blocked = excluded || new Set();
  let pool = AI_INTERVIEW_TEMPLATES.filter((t) =>
    (difficulty === "mixed" || t.difficulty === difficulty) &&
    (pattern === "all" || t.pattern === pattern) &&
    (!opts.topic || t.topic === opts.topic) &&
    !blocked.has(t.id)
  );
  // A batch may contain more items than the selected niche; only then allow
  // a blueprint to repeat with fresh inputs instead of failing the whole run.
  if (!pool.length) {
    pool = AI_INTERVIEW_TEMPLATES.filter((t) =>
      (difficulty === "mixed" || t.difficulty === difficulty) &&
      (pattern === "all" || t.pattern === pattern) &&
      (!opts.topic || t.topic === opts.topic)
    );
  }
  if (!pool.length) throw new Error("No interview blueprint matches that difficulty, pattern and topic combination.");
  return AI_ivWeightedPick(pool, opts.track || "mixed");
}

function AI_buildInterviewProblem(opts, excluded) {
  const tpl = AI_pickInterviewTemplate(opts, excluded);
  const p = tpl.make();
  const track = AI_ivTrack((opts && opts.track) || "mixed");
  p.template_id = tpl.id;
  p.track = (opts && opts.track) || "mixed";
  p.track_label = track.label;
  p.description += `\n\nPRACTICE TRACK\n${track.label}: ${track.coaching}\nThis is an original company-pattern practice challenge, not a company-issued or endorsed interview question.`;
  return { problem: p, templateId: tpl.id };
}

function AI_validateInterviewProblem(p, knownFps) {
  const checks = [];
  const has = (v) => String(v ?? "").trim().length > 0;
  const add = (label, pass) => checks.push({ label, pass: !!pass });
  const tests = Array.isArray(p.test_cases) ? p.test_cases : [];
  const hints = Array.isArray(p.hints) ? p.hints.filter((h) => has(h) && String(h).trim().length >= 12) : [];
  add("Write-Code problem type", p.type === "coding");
  add("Specific title and detailed prompt", has(p.title) && String(p.title).length >= 16 && String(p.description || "").length >= 500);
  add("Known topic, pattern and difficulty", AI_TOPICS.includes(p.topic) && !!AI_INTERVIEW_PATTERN_LABELS[p.pattern] && ["easy", "medium", "hard"].includes(p.difficulty));
  add("Function scaffold present", /^def solve\([^\n]*\):/.test(String(p.starter_code || "").trim()));
  add("Independent reference solution present", /^def solve\([^\n]*\):/.test(String(p.solution_code || "").trim()) && p.solution_code !== p.starter_code);
  let scaffoldShape = false, solutionShape = false;
  try { scaffoldShape = AI_codeShapeOK(p.starter_code); solutionShape = AI_codeShapeOK(p.solution_code); } catch (e) { /* failed below */ }
  add("Scaffold and reference have balanced code structure", scaffoldShape && solutionShape);
  add("At least 8 functional tests", tests.length >= 8 && tests.length <= 30);
  add("Every test has a solve(...) call and expected value", tests.every((t) => t && /^solve\([\s\S]*\)$/.test(String(t.call || "")) && Object.prototype.hasOwnProperty.call(t, "expected") && typeof t.expected === "string"));
  add("All test calls are unique", new Set(tests.map((t) => t.call)).size === tests.length);
  add("Sample expected output is derived from first test", tests.length > 0 && String(p.expected_output ?? "") === tests[0].expected && has(p.expected_output));
  add("Two visible samples; remaining cases cover unseen edges", p.public_test_count === 2 && tests.length >= 8 && Array.isArray(p.edge_cases) && p.edge_cases.length >= 3);
  add("Exactly 3 distinct progressive hints", hints.length === 3 && new Set(hints.map((h) => h.trim().toLowerCase())).size === 3);
  add("Constraints and complexity targets included", Array.isArray(p.constraints) && p.constraints.length >= 3 && /O\(/i.test(p.time_target || "") && /O\(/i.test(p.space_target || "") && String(p.description).includes("INTERVIEW TARGET"));
  add("At least 2 interviewer follow-ups", Array.isArray(p.followups) && p.followups.length >= 2 && p.followups.every(has));
  add("Scored interview rubric included", Array.isArray(p.rubric) && p.rubric.length === 4 && p.rubric.reduce((sum, r) => sum + (Number(r.weight) || 0), 0) === 100);
  add("No fabricated company attribution or success guarantee", !/(actually asked|real question from|guarantee[ds]?\b|80\s*%|90\s*%)/i.test(`${p.title}\n${p.description}`));
  add("Deterministic answer proof attached", has(p.proof) && String(p.proof).includes("computed"));
  if (knownFps) {
    const fp = AI_problemFingerprint(p);
    add("Not a duplicate of existing content", !fp || !knownFps.has(fp));
  }
  return { ok: checks.every((c) => c.pass), checks, score: Math.round((checks.filter((c) => c.pass).length / checks.length) * 100) };
}

async function AI_previewInterviewProblem(opts) {
  const { fps } = await AI_fetchProblemsIndex();
  let last = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const built = AI_buildInterviewProblem(opts || {});
      const validation = AI_validateInterviewProblem(built.problem, fps);
      last = { ...built, checks: validation.checks, score: validation.score };
      if (validation.ok) return last;
    } catch (e) {
      if (attempt === 39) throw e;
    }
  }
  return last;
}

async function AI_generateInterviewProblems(count, opts) {
  opts = opts || {};
  const settings = AI_getSettings();
  const n = Math.max(1, Math.min(20, Number(count) || settings.interview_count || 3));
  const { fps, maxNum } = await AI_fetchProblemsIndex();
  const used = new Set();
  const batch = [];
  let nextNum = maxNum;
  let skipped = 0;

  for (let slot = 0; slot < n; slot++) {
    let accepted = null;
    for (let attempt = 0; attempt < 40 && !accepted; attempt++) {
      let built;
      try { built = AI_buildInterviewProblem(opts, used); } catch (e) { if (attempt === 39) throw e; else continue; }
      const p = built.problem;
      const validation = AI_validateInterviewProblem(p, fps);
      if (!validation.ok) continue;
      const fp = AI_problemFingerprint(p);
      if (fp) fps.add(fp);
      used.add(built.templateId);
      const number = ++nextNum;
      accepted = {
        type: "coding",
        status: opts.status === "published" ? "published" : "draft",
        title: p.title,
        slug: AI_slugFor(p.title, number),
        description: p.description,
        difficulty: p.difficulty,
        topic: p.topic,
        problem_number: number,
        is_premium: false,
        admin_skip_notification: true,
        starter_code: p.starter_code,
        expected_output: p.expected_output,
        solution_code: p.solution_code,
        test_cases: p.test_cases,
        hints: p.hints,
        _pattern: p.pattern,
        _track: p.track,
        _proof: p.proof,
      };
    }
    if (!accepted) skipped++;
    else batch.push(accepted);
  }

  if (typeof opts.premium === "boolean") batch.forEach((p) => { p.is_premium = opts.premium; });
  else AI_applyPremiumMix(batch, settings);

  const added = [];
  const insertErrors = [];
  for (const payload of batch) {
    const { _pattern, _track, _proof, ...row } = payload;
    const { error } = await sb.from("problems").insert(row);
    if (error) {
      skipped++;
      insertErrors.push({ title: row.title, message: String(error.message || error) });
      AI_log("problem_error", `Interview insert failed for "${row.title}": ${error.message}`, "error");
      continue;
    }
    added.push(row);
    AI_log("problem_added", `#${row.problem_number} "${row.title}" [interview/${_pattern}/${row.difficulty}/${row.status}]${row.is_premium ? " ⭐ PREMIUM" : ""} — ${row.test_cases.length} tests; ${_proof}`, "success");
  }

  AI_setLastRun("interview_generate");
  if (!added.length) AI_log("problem_run", `Interview Studio tried ${n} challenge(s) — all skipped or rejected.`, "warn");
  else if (rowStatusIsPublished(added) && (settings.announce || opts.announce)) {
    const published = added.filter((p) => p.status === "published");
    try { await AI_broadcastNewProblems(published); } catch (e) { AI_log("announce_error", "Interview broadcast failed: " + e.message, "error"); }
  }
  return { added, skipped, errors: insertErrors, track: opts.track || "mixed" };
}

function rowStatusIsPublished(rows) {
  return Array.isArray(rows) && rows.some((row) => row.status === "published");
}
