#!/usr/bin/env python3
"""
Static server for HeadTracking Hologram3D.

The app needs a secure context: `getUserMedia` is refused otherwise, and ES
modules will not load over file://.

    python serve.py                 # http://localhost:8000  — desktop
    python serve.py --https         # https://<your-lan-ip>:8443 — phones
    python serve.py --https 8443

`http://localhost` counts as secure, so plain HTTP is fine on the machine
running the server. A phone reaching the same server over the LAN does NOT get
that exemption: `http://192.168.x.x` is an insecure origin and the camera will
be blocked with no useful error. `--https` generates a self-signed certificate
so mobile browsers will hand over the camera after you accept the warning once.
"""

import argparse
import datetime
import http.server
import ipaddress
import os
import socket
import socketserver
import ssl
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, ".certs")
CERT_FILE = os.path.join(CERT_DIR, "hologram3d.pem")


class Handler(http.server.SimpleHTTPRequestHandler):
    # glTF and wasm are absent from Python's mimetypes table on Windows, and a
    # wrong Content-Type on the wasm makes MediaPipe fail to stream-compile.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".gltf": "model/gltf+json",
        ".glb": "model/gltf-binary",
        ".bin": "application/octet-stream",
        ".wasm": "application/wasm",
        ".ktx2": "image/ktx2",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        first = args[0] if args else ""
        if "favicon" not in str(first):
            sys.stderr.write("  %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ip():
    """Best-effort LAN address. The UDP socket never sends anything."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(host_ip):
    """Create a self-signed cert covering localhost and the current LAN IP."""
    if os.path.exists(CERT_FILE):
        return CERT_FILE

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        sys.exit(
            "  --https needs the 'cryptography' package:\n"
            "      pip install cryptography\n"
            "  Alternatively, tunnel the plain HTTP server with ngrok or cloudflared."
        )

    print("  generating a self-signed certificate…")
    os.makedirs(CERT_DIR, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HeadTracking Hologram3D")])
    now = datetime.datetime.now(datetime.timezone.utc)

    alt_names = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    try:
        alt_names.append(x509.IPAddress(ipaddress.ip_address(host_ip)))
    except ValueError:
        pass

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    with open(CERT_FILE, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    return CERT_FILE


def main():
    ap = argparse.ArgumentParser(description="Serve HeadTracking Hologram3D.")
    ap.add_argument("port", nargs="?", type=int, default=None)
    ap.add_argument("--https", action="store_true",
                    help="serve over TLS with a self-signed cert (needed for phones on the LAN)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    port = args.port or (8443 if args.https else 8000)
    scheme = "https" if args.https else "http"
    ip = lan_ip()

    httpd = Server(("0.0.0.0", port), Handler)

    if args.https:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(ensure_cert(ip))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    local = f"{scheme}://localhost:{port}/index.html"
    lan = f"{scheme}://{ip}:{port}/index.html"

    print(f"\n  ◈ HeadTracking Hologram3D")
    print(f"    this machine : {local}")
    print(f"    phone / LAN  : {lan}")
    if not args.https:
        print("\n    NOTE: phones will refuse the camera over plain http://<ip>.")
        print("          Restart with --https to test on a phone.")
    else:
        print("\n    The certificate is self-signed, so the phone will warn once:")
        print("    tap Advanced -> Proceed. The camera works normally after that.")
    print("\n  Ctrl-C to stop.\n")

    if not args.no_browser:
        try:
            webbrowser.open(local)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
