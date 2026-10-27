mod auth;
mod bridge;
mod connect;
mod db;
mod error;
mod library;
mod server;

use std::time::Duration;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = server::Config::from_env()?;
    let origin = config.catalog_origin.clone();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()?;
    match std::env::args().nth(1).as_deref() {
        Some("--capabilities") => {
            println!(
                "{}",
                serde_json::json!({"nativeConnect":true,"runtime":"rust","catalog":"node"})
            );
            return Ok(());
        }
        Some("--healthcheck") => {
            let health: serde_json::Value = client
                .get(format!(
                    "http://{}/health",
                    config.listen.replace("0.0.0.0", "127.0.0.1")
                ))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if health["status"] != "ok" || health["apiVersion"] != 1 {
                return Err("Readiness failed".into());
            }
            return Ok(());
        }
        None => {}
        _ => return Err("Usage: doublemusic-core [--healthcheck|--capabilities]".into()),
    }
    // A single container keeps existing Compose mounts and administration commands.
    // An explicitly configured private worker can instead run in a separate process.
    let mut worker = if std::env::var_os("CATALOG_ORIGIN").is_none() {
        let port = config.listen.rsplit(':').next().unwrap().parse::<u16>()?;
        if port == 3001 {
            return Err("PORT 3001 is reserved for the internal catalog worker".into());
        }
        Some(
            tokio::process::Command::new("node")
                .arg("server.js")
                .env("HOST", "127.0.0.1")
                .env("PORT", "3001")
                .env("CONNECT_DISABLED", "true")
                .env("CORE_DB", &config.database)
                .kill_on_drop(true)
                .spawn()?,
        )
    } else {
        None
    };
    let (app, connect) = server::application(config.clone())?;
    #[cfg(unix)]
    {
        let mut signal =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined2())?;
        let draining = connect.clone();
        tokio::spawn(async move {
            while signal.recv().await.is_some() {
                draining.drain().await;
            }
        });
    }
    // Scanning may take a long time. The public listener opens only after readiness.
    loop {
        if let Some(child) = worker.as_mut()
            && child.try_wait()?.is_some()
        {
            return Err("Catalog worker exited during startup".into());
        }
        if client
            .get(format!("{origin}/health"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        tokio::select! {
            _ = shutdown() => { stop_worker(&mut worker).await; return Ok(()); },
            _ = tokio::time::sleep(Duration::from_millis(200)) => {},
        }
    }
    let listener = tokio::net::TcpListener::bind(&config.listen).await?;
    println!(
        "[DoubleMusic] Rust core listening on {}",
        listener.local_addr()?
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let serving = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = stopped.await;
    });
    let running = std::future::IntoFuture::into_future(serving);
    tokio::pin!(running);
    let mut completed = false;
    let result = tokio::select! {
        result = &mut running => { completed = true; result.map_err(|e| e.into()) },
        _ = shutdown() => Ok(()),
        status = async { match worker.as_mut() { Some(w) => w.wait().await, None => std::future::pending().await } } => {
            eprintln!("[DoubleMusic] Catalog worker exited: {status:?}");
            Err("Catalog worker exited".into())
        },
    };
    connect.close().await;
    let _ = stop.send(());
    if !completed {
        let _ = tokio::time::timeout(Duration::from_secs(15), &mut running).await;
    }
    stop_worker(&mut worker).await;
    result
}
async fn shutdown() {
    let terminate = async {
        #[cfg(unix)]
        {
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .unwrap()
                .recv()
                .await;
        }
        #[cfg(not(unix))]
        std::future::pending::<()>().await;
    };
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate => {} }
}
async fn stop_worker(worker: &mut Option<tokio::process::Child>) {
    if let Some(child) = worker.as_mut() {
        #[cfg(unix)]
        if let Some(id) = child.id() {
            let _ = tokio::process::Command::new("node")
                .args(["-e", "try { process.kill(Number(process.argv[1]), 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') process.exitCode = 1; }", &id.to_string()])
                .status()
                .await;
        }
        if tokio::time::timeout(Duration::from_secs(16), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}
