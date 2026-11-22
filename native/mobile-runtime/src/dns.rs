use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde_json::Value;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
pub struct Resolver {
    client: reqwest::Client,
    endpoints: Vec<Endpoint>,
    cache: Arc<Mutex<HashMap<String, (Instant, Vec<SocketAddr>)>>>,
}
#[derive(Clone)]
enum Endpoint {
    Https(String),
    Tcp(SocketAddr),
}
fn endpoints(raw: &str) -> Result<Vec<Endpoint>, String> {
    let servers: Vec<_> = raw
        .split([',', '\n'])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    if raw.len() > 8192 || servers.is_empty() || servers.len() > 4 {
        return Err("Custom DNS needs one to four servers".into());
    }
    servers
        .into_iter()
        .map(|server| {
            if server.starts_with("https://") {
                let url = reqwest::Url::parse(server).map_err(|_| "Invalid DNS HTTPS URL")?;
                if !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                    || url.query().is_some()
                {
                    return Err("Use a DNS HTTPS URL without credentials, query or fragment".into());
                }
                Ok(Endpoint::Https(url.into()))
            } else {
                let address = server
                    .parse::<SocketAddr>()
                    .ok()
                    .or_else(|| {
                        server
                            .trim_start_matches('[')
                            .trim_end_matches(']')
                            .parse::<IpAddr>()
                            .ok()
                            .map(|ip| SocketAddr::new(ip, 53))
                    })
                    .filter(|v| v.port() != 0)
                    .ok_or("Use a DNS server IP with an optional port, or an HTTPS URL")?;
                Ok(Endpoint::Tcp(address))
            }
        })
        .collect()
}
impl Resolver {
    pub fn new(provider: &str, custom: &str) -> Result<Option<Arc<Self>>, String> {
        if provider.is_empty() || provider == "system" {
            return Ok(None);
        }
        let mut client = crate::http_client_builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3));
        let endpoints = if provider == "custom" {
            endpoints(custom)?
        } else {
            let providers: Value =
                serde_json::from_str(include_str!("../assets/dns-providers.json")).unwrap();
            let preset = providers.get(provider).ok_or("Unknown DNS_RESOLVER")?;
            let url = preset["url"].as_str().unwrap();
            let target = reqwest::Url::parse(url).unwrap();
            let ip: IpAddr = preset["bootstrap"].as_str().unwrap().parse().unwrap();
            client = client.resolve(target.host_str().unwrap(), SocketAddr::new(ip, 443));
            vec![Endpoint::Https(url.into())]
        };
        Ok(Some(Arc::new(Self {
            client: client
                .build()
                .map_err(|_| "Could not prepare the DNS resolver")?,
            endpoints,
            cache: Arc::new(Mutex::new(HashMap::new())),
        })))
    }
    async fn exchange(&self, endpoint: &Endpoint, packet: &[u8]) -> Result<Vec<u8>, String> {
        match endpoint {
            Endpoint::Https(url) => {
                let mut response = self
                    .client
                    .post(url)
                    .body(packet.to_vec())
                    .header("accept", "application/dns-message")
                    .header("content-type", "application/dns-message")
                    .send()
                    .await
                    .map_err(|_| "DNS server could not be reached")?
                    .error_for_status()
                    .map_err(|_| "DNS server is unavailable")?;
                if response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split(';').next())
                    != Some("application/dns-message")
                {
                    return Err("Invalid DNS response type".into());
                }
                let mut bytes = vec![];
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "DNS response interrupted")?
                {
                    if bytes.len() + chunk.len() > 32768 {
                        return Err("DNS response exceeded its limit".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(bytes)
            }
            Endpoint::Tcp(address) => {
                let mut socket = tokio::net::TcpStream::connect(address)
                    .await
                    .map_err(|_| "DNS server could not be reached")?;
                socket
                    .write_all(&(packet.len() as u16).to_be_bytes())
                    .await
                    .map_err(|_| "DNS query interrupted")?;
                socket
                    .write_all(packet)
                    .await
                    .map_err(|_| "DNS query interrupted")?;
                let length = socket
                    .read_u16()
                    .await
                    .map_err(|_| "DNS response interrupted")? as usize;
                if !(12..=32768).contains(&length) {
                    return Err("Invalid DNS frame size".into());
                }
                let mut bytes = vec![0; length];
                socket
                    .read_exact(&mut bytes)
                    .await
                    .map_err(|_| "DNS response interrupted")?;
                Ok(bytes)
            }
        }
    }
    async fn query(&self, host: &str, kind: &str) -> Result<Value, String> {
        let packet = crate::dns_wire::question(host, if kind == "A" { 1 } else { 28 })?;
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut error = "DNS server is unavailable".to_string();
            let deadline = Instant::now() + Duration::from_secs(5);
            for (index, endpoint) in self.endpoints.iter().enumerate() {
                match tokio::time::timeout(
                    deadline.saturating_duration_since(Instant::now())
                        / (self.endpoints.len() - index) as u32,
                    self.exchange(endpoint, &packet),
                )
                .await
                {
                    Ok(Ok(bytes)) => match crate::dns_wire::answer(&bytes, &packet) {
                        Ok(value) => return Ok(value),
                        Err(cause) => error = cause,
                    },
                    Ok(Err(cause)) => error = cause,
                    Err(_) => error = "DNS server timed out".into(),
                }
            }
            Err(error)
        })
        .await
        .map_err(|_| "DNS server timed out")?
    }
    pub async fn lookup(&self, host: &str) -> Result<Vec<SocketAddr>, String> {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, 0)]);
        }
        if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
            return tokio::net::lookup_host((host, 0))
                .await
                .map(|v| v.collect())
                .map_err(|_| "Local hostname could not be resolved".into());
        }
        if let Some((until, addresses)) = self.cache.lock().unwrap().get(host) {
            if *until > Instant::now() {
                return Ok(addresses.clone());
            }
        }
        let (a, aaaa) = tokio::try_join!(self.query(host, "A"), self.query(host, "AAAA"))?;
        let mut addresses = vec![];
        let mut ttl = 300;
        for value in [a, aaaa] {
            if value["Status"] != 0 {
                continue;
            }
            for answer in value["Answer"].as_array().into_iter().flatten().take(64) {
                if !matches!(answer["type"].as_u64(), Some(1 | 28)) {
                    continue;
                }
                if let Some(ip) = answer["data"]
                    .as_str()
                    .and_then(|v| v.parse::<IpAddr>().ok())
                {
                    if !matches!(
                        (answer["type"].as_u64(), ip),
                        (Some(1), IpAddr::V4(_)) | (Some(28), IpAddr::V6(_))
                    ) {
                        continue;
                    }
                    ttl = ttl.min(answer["TTL"].as_u64().unwrap_or(0));
                    let address = SocketAddr::new(ip, 0);
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
            }
        }
        if addresses.is_empty() {
            return Err("Configured DNS provider returned no addresses".into());
        }
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(
            host.into(),
            (Instant::now() + Duration::from_secs(ttl), addresses.clone()),
        );
        Ok(addresses)
    }
}
impl Resolve for Resolver {
    fn resolve(&self, name: Name) -> Resolving {
        let resolver = self.clone();
        Box::pin(async move {
            let values = resolver
                .lookup(name.as_str())
                .await
                .map_err(std::io::Error::other)?;
            Ok(Box::new(values.into_iter()) as Addrs)
        })
    }
}

pub struct Proxy {
    pub port: u16,
    pub token: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Proxy {
    pub async fn start(resolver: Arc<Resolver>) -> Result<Self, String> {
        // macOS needs an explicit alias for 127.0.0.2; host tests exercise forwarding on its primary loopback.
        let address = if cfg!(all(test, not(target_os = "android"))) {
            "127.0.0.1:0"
        } else {
            "127.0.0.2:0"
        };
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|_| "Could not start the instance DNS forwarder")?;
        let port = listener
            .local_addr()
            .map_err(|_| "DNS forwarder has no address")?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        use base64::Engine;
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("trawl:{token}"))
        );
        let task = tokio::spawn(async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>match accepted {
                        Ok((socket,_)) if clients.len()<16 => {let resolver=resolver.clone();let auth=expected.clone();clients.spawn(async move {let _=tokio::time::timeout(Duration::from_secs(180),forward(socket,resolver,auth)).await;});},
                        Ok(_)=>{}, Err(_)=>break,
                    },
                    _=clients.join_next(), if !clients.is_empty()=>{},
                }
            }
        });
        Ok(Self { port, token, task })
    }
}
async fn forward(
    mut client: tokio::net::TcpStream,
    resolver: Arc<Resolver>,
    auth: String,
) -> Result<(), String> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16384 {
            return Err("Proxy headers exceeded their limit".into());
        }
        let mut byte = [0];
        tokio::time::timeout(Duration::from_secs(10), client.read_exact(&mut byte))
            .await
            .map_err(|_| "Proxy headers timed out")?
            .map_err(|_| "Proxy closed")?;
        header.push(byte[0]);
    }
    let raw = std::str::from_utf8(&header).map_err(|_| "Invalid proxy headers")?;
    let mut lines = raw.split("\r\n");
    let request = lines.next().ok_or("Missing request")?;
    let fields: Vec<_> = request.split_whitespace().collect();
    if fields.len() != 3 {
        return Err("Invalid request".into());
    }
    let headers: Vec<_> = lines.filter(|line| !line.is_empty()).collect();
    if !headers.iter().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("proxy-authorization") && value.trim() == auth
        })
    }) {
        client.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"TRAWL-DNS\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.map_err(|_|"Proxy closed")?;
        return Ok(());
    }
    let connect = fields[0] == "CONNECT";
    let url = reqwest::Url::parse(&if connect {
        format!("https://{}", fields[1])
    } else {
        fields[1].to_owned()
    })
    .map_err(|_| "Invalid target")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid target".into());
    }
    let host = url
        .host_str()
        .ok_or("Missing hostname")?
        .trim_start_matches('[')
        .trim_end_matches(']');
    if host == "127.0.0.2" || (!connect && url.scheme() != "http") {
        return Err("Reserved proxy host or invalid forwarding scheme".into());
    }
    let port = url.port_or_known_default().ok_or("Missing port")?;
    let mut peer = None;
    for mut address in resolver.lookup(host).await? {
        if address.ip().to_canonical() == "127.0.0.2".parse::<IpAddr>().unwrap() {
            return Err("Reserved proxy host".into());
        }
        address.set_port(port);
        if let Ok(Ok(socket)) = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect(address),
        )
        .await
        {
            peer = Some(socket);
            break;
        }
    }
    let mut peer = peer.ok_or("Target connection failed")?;
    if connect {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .map_err(|_| "Proxy closed")?;
    } else {
        let path = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_owned(),
        };
        let mut outgoing = format!("{} {path} {}\r\n", fields[0], fields[2]);
        for header in headers {
            let name = header.split(':').next().unwrap_or("");
            if !name.eq_ignore_ascii_case("proxy-authorization")
                && !name.eq_ignore_ascii_case("proxy-connection")
                && !name.eq_ignore_ascii_case("connection")
            {
                outgoing.push_str(header);
                outgoing.push_str("\r\n");
            }
        }
        outgoing.push_str("Connection: close\r\n\r\n");
        peer.write_all(outgoing.as_bytes())
            .await
            .map_err(|_| "Target closed")?;
    }
    tokio::io::copy_bidirectional(&mut client, &mut peer)
        .await
        .map_err(|_| "Proxy connection interrupted")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn custom_tcp_dns_and_configuration_use_the_selected_server() {
        for value in [
            "",
            "host:53",
            "1.1.1.1:0",
            "https://user:pass@dns.example/",
            "https://dns.example/#fragment",
        ] {
            assert!(endpoints(value).is_err());
        }
        assert!(endpoints("1.0.0.1,[::1]:5353,https://dns.example/dns-query").is_ok());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let length = socket.read_u16().await.unwrap() as usize;
                    let mut bytes = vec![0; length];
                    socket.read_exact(&mut bytes).await.unwrap();
                    let response = crate::dns_wire::fixture(&bytes);
                    socket
                        .write_all(&(response.len() as u16).to_be_bytes())
                        .await
                        .unwrap();
                    socket.write_all(&response).await.unwrap();
                });
            }
        });
        let resolver = Resolver::new("custom", &address.to_string())
            .unwrap()
            .unwrap();
        let answers = resolver.lookup("owned.fixture").await.unwrap();
        assert_eq!(answers, vec!["127.0.0.1:0".parse::<SocketAddr>().unwrap()]);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn custom_dns_and_authenticated_forwarding_reach_the_selected_address() {
        use axum::{
            routing::{get, post},
            Router,
        };
        let dns_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dns_port = dns_listener.local_addr().unwrap().port();
        let dns = tokio::spawn(async move {
            axum::serve(
                dns_listener,
                Router::new().route(
                    "/resolve",
                    post(|body: axum::body::Bytes| async move {
                        (
                            [("content-type", "application/dns-message")],
                            crate::dns_wire::fixture(&body),
                        )
                    }),
                ),
            )
            .await
            .unwrap()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/",
                    get(|headers: axum::http::HeaderMap| async move {
                        assert!(!headers.contains_key("proxy-authorization"));
                        "scoped resolver"
                    }),
                ),
            )
            .await
            .unwrap()
        });
        let resolver = Arc::new(Resolver {
            client: reqwest::Client::new(),
            endpoints: vec![Endpoint::Https(format!(
                "http://127.0.0.1:{dns_port}/resolve"
            ))],
            cache: Arc::new(Mutex::new(HashMap::new())),
        });
        let target = format!("http://owned.fixture:{port}/");
        let client = crate::http_client_builder()
            .no_proxy()
            .dns_resolver(resolver.clone())
            .build()
            .unwrap();
        assert_eq!(
            client
                .get(&target)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "scoped resolver"
        );
        let proxy = Proxy::start(resolver).await.unwrap();
        let client = crate::http_client_builder()
            .proxy(
                reqwest::Proxy::http(format!("http://127.0.0.1:{}", proxy.port))
                    .unwrap()
                    .basic_auth("trawl", &proxy.token),
            )
            .build()
            .unwrap();
        assert_eq!(
            client
                .get(&target)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "scoped resolver"
        );
        let unauthenticated = crate::http_client_builder()
            .proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{}", proxy.port)).unwrap())
            .build()
            .unwrap();
        assert_eq!(
            unauthenticated.get(&target).send().await.unwrap().status(),
            407
        );
        assert!(Resolver::new("typo", "").is_err());
        assert!(Resolver::new("system", "").unwrap().is_none());
        origin.abort();
        dns.abort();
    }
}
