//! The 88 operator routings. Line N of web/algorithms.txt is algorithm N.
//!
//! Each line lists chains such as `8>7>3`: OP8 modulates OP7, which modulates OP3.
//! An operator may appear in several chains, so one operator can modulate several
//! others or receive several modulators. An operator that modulates nothing is a
//! carrier and goes to the output. A modulator always has a higher number than its
//! target, so the engine can compute OP8 down to OP1 in one pass. OP8 never has a
//! modulator, and it is the operator with self-feedback.
use crate::engine::OPS;

pub const COUNT: u32 = 88;
const TABLE: &str = include_str!("../web/algorithms.txt");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Route {
    /// Bit j of `modulators[i]` is set when operator j modulates operator i (zero-based).
    pub modulators: [u8; OPS],
    /// Bit i is set when operator i is a carrier.
    pub carriers: u8,
}

/// The routing text of an algorithm from 1 to 88.
pub fn spec(algorithm: u32) -> Option<&'static str> {
    if !(1..=COUNT).contains(&algorithm) { return None; }
    TABLE.lines().nth(algorithm as usize - 1)
}

/// The routing of an algorithm. Numbers outside 1–88 are clamped into range.
pub fn route(algorithm: u32) -> Route {
    parse(spec(algorithm.clamp(1, COUNT)).expect("88 lines")).expect("valid algorithm table")
}

/// Reads one line of the table. Returns None unless every operator appears once or more
/// and every modulator has a higher number than its target.
pub fn parse(spec: &str) -> Option<Route> {
    let mut modulators = [0u8; OPS];
    let mut seen = 0u8;
    for chain in spec.split_whitespace() {
        let mut upper: Option<usize> = None;
        for token in chain.split('>') {
            let op: usize = token.parse().ok()?;
            if !(1..=OPS).contains(&op) { return None; }
            let i = op - 1;
            seen |= 1 << i;
            if let Some(source) = upper {
                if source <= i { return None; }
                modulators[i] |= 1 << source;
            }
            upper = Some(i);
        }
    }
    if seen != u8::MAX { return None; }
    let sources = modulators.iter().fold(0, |all, m| all | m);
    Some(Route { modulators, carriers: !sources })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edges(r: &Route) -> Vec<(usize, usize)> {
        (0..OPS).flat_map(|i| (0..OPS).filter(move |j| r.modulators[i] >> j & 1 == 1).map(move |j| (j, i))).collect()
    }

    // Every relabeling of OP1–OP7, so two shapes count as the same if only the numbering differs.
    fn canonical(r: &Route) -> Vec<(usize, usize)> {
        let e = edges(r);
        let mut order: Vec<usize> = (0..OPS - 1).collect();
        let mut best: Option<Vec<(usize, usize)>> = None;
        let mut c = [0; OPS - 1];
        let mut consider = |order: &[usize]| {
            let map = |x: usize| if x == OPS - 1 { x } else { order[x] };
            let mut mapped: Vec<_> = e.iter().map(|&(a, b)| (map(a), map(b))).collect();
            mapped.sort();
            if best.as_ref().is_none_or(|b| mapped < *b) { best = Some(mapped); }
        };
        consider(&order);
        let mut i = 0;
        while i < order.len() {
            if c[i] < i {
                if i % 2 == 0 { order.swap(0, i) } else { order.swap(c[i], i) }
                consider(&order);
                c[i] += 1;
                i = 0;
            } else {
                c[i] = 0;
                i += 1;
            }
        }
        best.unwrap()
    }

    #[test]
    fn table_has_88_distinct_valid_routings() {
        assert_eq!(TABLE.lines().count(), COUNT as usize);
        let routes: Vec<Route> = (1..=COUNT).map(|n| parse(spec(n).unwrap()).unwrap_or_else(|| panic!("algorithm {n}"))).collect();
        let mut previous_carriers = 0;
        let mut shapes = std::collections::HashSet::new();
        for (n, r) in routes.iter().enumerate() {
            assert_eq!(r.modulators[OPS - 1], 0, "OP8 feedback stays its only input");
            assert_eq!(r.carriers & 1, 1, "OP1 is always a carrier");
            let carriers = r.carriers.count_ones();
            assert!(carriers >= previous_carriers, "carriers never decrease");
            previous_carriers = carriers;
            assert!(shapes.insert(canonical(r)), "algorithm {} repeats another shape", n + 1);
        }
        assert_eq!(routes[0].carriers.count_ones(), 1);
        assert_eq!(routes[87].carriers, u8::MAX);
    }

    #[test]
    fn rejects_bad_lines() {
        assert!(parse("8 7 6 5 4 3 2").is_none());
        assert!(parse("1>2 3 4 5 6 7 8").is_none());
        assert!(parse("9 8 7 6 5 4 3 2 1").is_none());
        assert_eq!(route(0), route(1));
        assert_eq!(route(200), route(88));
    }
}
