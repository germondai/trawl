use serde_json::{json, Value};

pub fn question(host: &str, kind: u16) -> Result<Vec<u8>, String> {
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty()
        || name.len() > 253
        || name.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
    {
        return Err("Invalid DNS hostname".into());
    }
    let id = uuid::Uuid::new_v4();
    let mut bytes = vec![
        id.as_bytes()[0],
        id.as_bytes()[1],
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
    for label in name.split('.') {
        bytes.push(label.len() as u8);
        bytes.extend_from_slice(label.as_bytes());
    }
    bytes.push(0);
    bytes.extend_from_slice(&kind.to_be_bytes());
    bytes.extend_from_slice(&1u16.to_be_bytes());
    Ok(bytes)
}
fn word(bytes: &[u8], offset: usize) -> Result<u16, String> {
    bytes
        .get(offset..offset + 2)
        .map(|v| u16::from_be_bytes([v[0], v[1]]))
        .ok_or("Invalid DNS response".into())
}
pub fn answer(bytes: &[u8], query: &[u8]) -> Result<Value, String> {
    let invalid = || "Invalid DNS response".to_string();
    if bytes.len() < query.len()
        || bytes.len() > 32768
        || bytes[..2] != query[..2]
        || word(bytes, 2)? & 0xfa00 != 0x8000
        || word(bytes, 4)? != 1
        || bytes[12..query.len()] != query[12..]
    {
        return Err(invalid());
    }
    let code = word(bytes, 2)? & 15;
    if code != 0 && code != 3 {
        return Err("DNS server could not resolve the query".into());
    }
    let count = word(bytes, 6)?;
    if count > 128 {
        return Err(invalid());
    }
    let mut offset = query.len();
    let mut answers = vec![];
    for _ in 0..count {
        let mut length = 0;
        loop {
            let size = *bytes.get(offset).ok_or_else(invalid)? as usize;
            offset += 1;
            if size == 0 {
                break;
            }
            if size & 0xc0 == 0xc0 {
                let start = offset - 1;
                let pointer = ((size & 63) << 8) | *bytes.get(offset).ok_or_else(invalid)? as usize;
                offset += 1;
                if pointer < 12 || pointer >= start {
                    return Err(invalid());
                }
                break;
            }
            length += size + 1;
            if size > 63 || length > 255 || offset + size > bytes.len() {
                return Err(invalid());
            }
            offset += size;
        }
        let kind = word(bytes, offset)?;
        let class = word(bytes, offset + 2)?;
        let ttl_bytes = bytes.get(offset + 4..offset + 8).ok_or_else(invalid)?;
        let ttl = u32::from_be_bytes(ttl_bytes.try_into().unwrap());
        let length = word(bytes, offset + 8)? as usize;
        offset += 10;
        let data = bytes.get(offset..offset + length).ok_or_else(invalid)?;
        if class == 1 && matches!(kind, 1 | 28) {
            let ip = if kind == 1 {
                std::net::IpAddr::V4(std::net::Ipv4Addr::from(
                    <[u8; 4]>::try_from(data).map_err(|_| invalid())?,
                ))
            } else {
                std::net::IpAddr::V6(std::net::Ipv6Addr::from(
                    <[u8; 16]>::try_from(data).map_err(|_| invalid())?,
                ))
            };
            answers.push(json!({"type": kind, "data": ip.to_string(), "TTL": ttl}));
        }
        offset += length;
    }
    Ok(json!({"Status": code, "Answer": answers}))
}

#[cfg(test)]
pub fn fixture(query: &[u8]) -> Vec<u8> {
    let mut bytes = query.to_vec();
    bytes[2] = 0x81;
    bytes[3] = 0x80;
    if query[query.len() - 3] == 1 {
        bytes[7] = 1;
        bytes.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
    }
    bytes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_identity_bounds_and_compression_are_checked() {
        let query = question("owned.fixture", 1).unwrap();
        let response = fixture(&query);
        assert_eq!(
            answer(&response, &query).unwrap()["Answer"][0]["data"],
            "127.0.0.1"
        );
        for end in 0..response.len() {
            assert!(answer(&response[..end], &query).is_err());
        }
        for offset in [0, 2, 5, 13] {
            let mut malformed = response.clone();
            malformed[offset] ^= 0x40;
            assert!(answer(&malformed, &query).is_err());
        }
        let mut malformed = response;
        malformed[query.len()] = 0xff;
        malformed[query.len() + 1] = 0xff;
        assert!(answer(&malformed, &query).is_err());
        assert!(question("bad..name", 1).is_err());
    }
}
