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
use hashx::HashX;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

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
}
