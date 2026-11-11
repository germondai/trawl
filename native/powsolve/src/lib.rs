// Anubis protocol and seed derivation: TecharoHQ/anubis (MIT); see ANUBIS-LICENSE.
//! Native proof-of-work solvers for trawl's Tier 1.
//!
//! Two search shapes cover the walls trawl meets:
//!
//! * `pow_text_sha256`: SHA-256 over `prefix || decimal(nonce)`. NCBI's identity PoW
//!   (`challengeId + ":" + nonce`) and Anubis' `fast`/`slow` algorithms use it.
//! * `pow_bytes`: Anubis' WebAssembly algorithms (`sha256`, `argon2id`, `hashx`), which
//!   treat the hex-decoded challenge as raw bytes and the nonce as a binary salt.
//!
//! Both search for a digest with at least `bits` leading zero bits, split the nonce
//! space across `threads` OS threads, and return the nonce (or -1) plus the digest.

use argon2::Argon2;
use blake2::{digest::consts::U32, Blake2b, Digest as Blake2Digest};
use hashx::HashX;
use sha2::Sha256;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

type Blake2b256 = Blake2b<U32>;

fn leading_zero_bits_ok(hash: &[u8], bits: u32) -> bool {
    let mut remaining = bits;
    for &byte in hash {
        if remaining == 0 {
            return true;
        }
        if remaining >= 8 {
            if byte != 0 {
                return false;
            }
            remaining -= 8;
        } else {
            return byte & (0xFFu8 << (8 - remaining)) == 0;
        }
    }
    remaining == 0
}

fn write_decimal(mut n: u32, buf: &mut [u8; 10]) -> &[u8] {
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    &buf[i..]
}

/// Runs `check(nonce)` over the u32 nonce space on `threads` threads. Thread t tries
/// t, t + threads, t + 2*threads, ... The first hit wins.
fn search<F>(threads: u32, check: F) -> Option<(u32, [u8; 32])>
where
    F: Fn(u32) -> Option<[u8; 32]> + Sync,
{
    let threads = threads.clamp(1, 64);
    let found = AtomicBool::new(false);
    let result: Mutex<Option<(u32, [u8; 32])>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for t in 0..threads {
            let (found, result, check) = (&found, &result, &check);
            scope.spawn(move || {
                let mut nonce = t;
                let mut i: u32 = 0;
                loop {
                    if let Some(hash) = check(nonce) {
                        if !found.swap(true, Ordering::AcqRel) {
                            *result.lock().unwrap() = Some((nonce, hash));
                        }
                        return;
                    }
                    i = i.wrapping_add(1);
                    if i & 0x3FF == 0 && found.load(Ordering::Acquire) {
                        return;
                    }
                    match nonce.checked_add(threads) {
                        Some(n) => nonce = n,
                        None => return,
                    }
                }
            });
        }
    });
    result.into_inner().unwrap()
}

pub fn solve_text_sha256(prefix: &[u8], bits: u32, threads: u32) -> Option<(u32, [u8; 32])> {
    let mut base = Sha256::new();
    base.update(prefix);
    search(threads, |nonce| {
        let mut buf = [0u8; 10];
        let mut h = base.clone();
        h.update(write_decimal(nonce, &mut buf));
        let hash: [u8; 32] = h.finalize().into();
        leading_zero_bits_ok(&hash, bits).then_some(hash)
    })
}

pub const ALGO_SHA256: u32 = 0;
pub const ALGO_ARGON2ID: u32 = 1;
pub const ALGO_HASHX: u32 = 2;

fn make_hashx(data: &[u8]) -> HashX {
    if let Ok(h) = HashX::new(data) {
        return h;
    }
    let mut seed = Vec::with_capacity(data.len() + 4);
    let mut counter: u32 = 0;
    loop {
        seed.clear();
        seed.extend_from_slice(data);
        seed.extend_from_slice(&counter.to_le_bytes());
        if let Ok(h) = HashX::new(&seed) {
            return h;
        }
        counter = counter.wrapping_add(1);
    }
}

pub fn solve_bytes(algo: u32, data: &[u8], bits: u32, threads: u32) -> Option<(u32, [u8; 32])> {
    // Anubis picks the nonce byte order from the last challenge byte.
    let use_le = data.last().copied().unwrap_or(0) >= 128;
    match algo {
        ALGO_SHA256 => {
            let mut base = Sha256::new();
            base.update(data);
            search(threads, |nonce| {
                let mut h = base.clone();
                h.update(if use_le { nonce.to_le_bytes() } else { nonce.to_be_bytes() });
                let hash: [u8; 32] = h.finalize().into();
                leading_zero_bits_ok(&hash, bits).then_some(hash)
            })
        }
        ALGO_ARGON2ID => search(threads, |nonce| {
            let n = nonce as u64;
            let salt = if use_le { n.to_le_bytes() } else { n.to_be_bytes() };
            let mut hash = [0u8; 32];
            Argon2::default().hash_password_into(data, &salt, &mut hash).ok()?;
            leading_zero_bits_ok(&hash, bits).then_some(hash)
        }),
        ALGO_HASHX => {
            let hx = make_hashx(data);
            search(threads, |nonce| {
                let hash: [u8; 32] = hx.hash_to_bytes(nonce as u64);
                leading_zero_bits_ok(&hash, bits).then_some(hash)
            })
        }
        _ => None,
    }
}

/// Solves a Friendly Captcha v1 puzzle using Blake2b-256.
/// Puzzle buffer layout: [timestamp:4][accountId:4][appId:4][version:1][expiry:1][nSolutions:1][difficulty:1]...
/// Hash input: 128 bytes padded with puzzle at start, [index, 0, 0, 0, nonce_le] at bytes 120-127.
/// Returns solutions as a Vec of (solution_index, nonce) pairs.
pub fn solve_friendly_captcha(puzzle: &[u8], threads: u32) -> Vec<(u8, u32)> {
    if puzzle.len() < 32 || puzzle.len() > 64 || puzzle[14] == 0 {
        return vec![];
    }

    let n_solutions = puzzle[14] as usize;
    let difficulty = puzzle[15];
    let threshold = (2.0_f64).powf((255.999 - difficulty as f64) / 8.0).floor() as u32;

    let threads = threads.clamp(1, 64);
    let mut solutions = Vec::with_capacity(n_solutions);

    for sol_idx in 0..n_solutions {
        let found = AtomicBool::new(false);
        let result_nonce = AtomicU32::new(0);

        std::thread::scope(|scope| {
            for t in 0..threads {
                let (found, result_nonce) = (&found, &result_nonce);
                let puzzle = puzzle;
                scope.spawn(move || {
                    let mut nonce = t;
                    let mut iter_count: u32 = 0;
                    let mut padded = [0u8; 128];
                    padded[..puzzle.len()].copy_from_slice(puzzle);
                    padded[120] = sol_idx as u8;
                    // bytes 121-123 stay 0
                    loop {
                        padded[124..128].copy_from_slice(&nonce.to_le_bytes());
                        let hash: [u8; 32] = Blake2b256::digest(&padded).into();
                        let hash_val = u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]);

                        if hash_val < threshold {
                            if !found.swap(true, Ordering::AcqRel) {
                                result_nonce.store(nonce, Ordering::Release);
                            }
                            return;
                        }

                        iter_count = iter_count.wrapping_add(1);
                        if iter_count & 0x3FF == 0 && found.load(Ordering::Acquire) {
                            return;
                        }
                        match nonce.checked_add(threads) {
                            Some(n) => nonce = n,
                            None => return,
                        }
                    }
                });
            }
        });

        if found.load(Ordering::Acquire) {
            solutions.push((sol_idx as u8, result_nonce.load(Ordering::Acquire)));
        }
    }

    solutions
}

fn finish(result: Option<(u32, [u8; 32])>, out_hash: *mut u8) -> i64 {
    match result {
        Some((nonce, hash)) => {
            if !out_hash.is_null() {
                // SAFETY: the caller passes a 32-byte buffer.
                unsafe { std::ptr::copy_nonoverlapping(hash.as_ptr(), out_hash, 32) };
            }
            nonce as i64
        }
        None => -1,
    }
}

/// # Safety
/// `prefix` points to `len` readable bytes; `out_hash` is null or 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn pow_text_sha256(prefix: *const u8, len: usize, bits: u32, threads: u32, out_hash: *mut u8) -> i64 {
    let prefix = if len == 0 { &[][..] } else { std::slice::from_raw_parts(prefix, len) };
    finish(solve_text_sha256(prefix, bits, threads), out_hash)
}

/// # Safety
/// `data` points to `len` readable bytes; `out_hash` is null or 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn pow_bytes(algo: u32, data: *const u8, len: usize, bits: u32, threads: u32, out_hash: *mut u8) -> i64 {
    let data = if len == 0 { &[][..] } else { std::slice::from_raw_parts(data, len) };
    finish(solve_bytes(algo, data, bits, threads), out_hash)
}

/// Solves a Friendly Captcha v1 puzzle using Blake2b-256.
/// Returns the number of solutions found. Each solution is written as 5 bytes:
/// [solution_index:1][nonce:4 LE] to `out_solutions`.
///
/// # Safety
/// `puzzle` points to `puzzle_len` readable bytes (32 through 64).
/// `out_solutions` points to at least `n_solutions * 5` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn pow_friendly_captcha(
    puzzle: *const u8,
    puzzle_len: usize,
    threads: u32,
    out_solutions: *mut u8,
) -> i32 {
    if puzzle.is_null() || puzzle_len < 32 || puzzle_len > 64 {
        return 0;
    }
    let puzzle = std::slice::from_raw_parts(puzzle, puzzle_len);
    let solutions = solve_friendly_captcha(puzzle, threads);

    if !out_solutions.is_null() {
        for (i, (sol_idx, nonce)) in solutions.iter().enumerate() {
            let offset = i * 5;
            *out_solutions.add(offset) = *sol_idx;
            let nonce_bytes = nonce.to_le_bytes();
            std::ptr::copy_nonoverlapping(nonce_bytes.as_ptr(), out_solutions.add(offset + 1), 4);
        }
    }

    solutions.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_sha256_meets_bits() {
        let (nonce, hash) = solve_text_sha256(b"jVIiDgKTP1fcnFLa52R8mQ:", 12, 4).unwrap();
        let mut h = Sha256::new();
        h.update(format!("jVIiDgKTP1fcnFLa52R8mQ:{nonce}"));
        let want: [u8; 32] = h.finalize().into();
        assert_eq!(hash, want);
        assert!(leading_zero_bits_ok(&hash, 12));
    }

    #[test]
    fn bytes_algorithms_meet_bits() {
        let data = [0x12u8, 0x34, 0x56, 0x99];
        for algo in [ALGO_SHA256, ALGO_HASHX] {
            let (_, hash) = solve_bytes(algo, &data, 10, 4).unwrap();
            assert!(leading_zero_bits_ok(&hash, 10));
        }
        let (_, hash) = solve_bytes(ALGO_ARGON2ID, &data, 2, 4).unwrap();
        assert!(leading_zero_bits_ok(&hash, 2));
    }

    #[test]
    fn proofs_accepted_by_upstream_anubis() {
        // Accepted by unmodified Anubis v1.28.2 on owned local targets.
        let decode = |hex: &str| {
            hex.as_bytes().chunks_exact(2).map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
            }).collect::<Vec<_>>()
        };
        let cases = [
            (0, "44e4480a482705241c4a262977f29cc660a4e643189b2a82e12b513b9fc2c76be35187adbc9c7d0588012864af7284faec04bf1c09919bd03ae28de1919b1010", 12, 6131, "0008d67dd599481e8c237989cd15e508796336748a8a592bd3bb8fd8e95f8ffc"),
            (1, "c7e5f676a9e9f842279d8238eaf816617064f6822e3c1cd26e98745be149fede17a4e076be806c55e9b6b2e53b3bf62a771f9b10c6190f515dbedcb73e988769", 2, 1, "38ae841c25d572060d195cd5feedc4fbd2ee6f9495989674f32a9edde4df8422"),
            (2, "f2777b9af8f4f77123761ae09d7d20abab00bb68acfdf996309927c65cea0b6561e79c4fdd0eb1c37c6d55de83da2119e85ef1dad83bb409b5ee731eb18172ca", 10, 392, "001b337f6eeb6b91a92ec1190d668a68f8f3b84c01f74e39d9270ba9804a7882"),
        ];
        for (algo, data, bits, nonce, hash) in cases {
            let result = solve_bytes(algo, &decode(data), bits, 1).unwrap();
            assert_eq!(result.0, nonce);
            assert_eq!(result.1.as_slice(), decode(hash).as_slice());
        }
    }

    #[test]
    fn friendly_captcha_solves_low_difficulty() {
        // Puzzle: 32 bytes with n_solutions=2 at byte 14, difficulty=120 at byte 15
        // threshold = floor(2^((255.999-120)/8)) as u32, so hash_val must be < threshold
        let mut puzzle = [0u8; 32];
        puzzle[14] = 2; // n_solutions
        puzzle[15] = 120; // difficulty (low, easy to solve)

        let solutions = solve_friendly_captcha(&puzzle, 4);
        assert_eq!(solutions.len(), 2);

        // Verify each solution produces a valid hash using 128-byte padded format
        let threshold = (2.0_f64).powf((255.999 - 120.0) / 8.0).floor() as u32;
        for (sol_idx, nonce) in &solutions {
            let mut padded = [0u8; 128];
            padded[..32].copy_from_slice(&puzzle);
            padded[120] = *sol_idx;
            padded[124..128].copy_from_slice(&nonce.to_le_bytes());
            let hash: [u8; 32] = Blake2b256::digest(&padded).into();
            let hash_val = u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]);
            assert!(hash_val < threshold, "hash_val={} should be < {}", hash_val, threshold);
        }

        puzzle[15] = 0;
        assert_eq!(solve_friendly_captcha(&puzzle, 1).len(), 2);
        assert!(solve_friendly_captcha(&puzzle[..16], 1).is_empty());
    }
}
