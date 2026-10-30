#!/usr/bin/env python3
"""Turn a google-services.json into the Android resources that Firebase reads at runtime.

Why this exists instead of the usual `com.google.gms.google-services` Gradle plugin: Element X does
not use that plugin. `app/build.gradle.kts` has its alias commented out, and the Firebase values are
hand-maintained XML in `libraries/pushproviders/firebase/src/{main,debug,release}/res/values/
firebase.xml`. Applying the plugin on top of that would (a) duplicate the very resource names those
files define — `google_app_id`, `gcm_defaultSenderId`, `google_api_key`, `project_id` — and (b) pull
a Gradle plugin from before AGP 9 into a build that runs AGP 9.3.2 and Gradle 9.8.2.

So this build keeps upstream's mechanism and only replaces the *values*: it writes an overlay into
`app/src/gplay/res/`. The app module outranks any library module during resource merging, so the
overlay wins over Element's `vector-alpha` project in the pushproviders library, and the `fdroid`
flavour stays exactly as upstream (no Firebase at all). With the values in place,
`FirebaseInitProvider` finds `google_app_id` and `FirebaseMessaging` finds `gcm_defaultSenderId` —
the two things a token request needs.

The second file is not optional decoration: AGP 9.3 enables resource shrinking whenever
`optimization { enable = true }` is set (which is our release build type), and Firebase looks these
strings up by name via `getIdentifier()`, so the shrinker cannot see the reference. `res/raw/
keep.xml` tells it to keep them; without it the app installs, launches, and then never obtains a
token.

Usage: firebase-resources.py <google-services.json> <res directory> [package name]
"""

import json
import pathlib
import sys
import xml.sax.saxutils as sax
from typing import NoReturn

DEFAULT_PACKAGE = "io.element.android.x"

# The four values Firebase cannot start without. `project_id` is also what CI greps the APK for.
REQUIRED = ("google_app_id", "gcm_defaultSenderId", "google_api_key", "project_id")


def fail(message: str, code: int = 1) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(code)


def pick_client(document: dict, package: str) -> dict:
    clients = document.get("client") or []
    for client in clients:
        info = (client.get("client_info") or {}).get("android_client_info") or {}
        if info.get("package_name") == package:
            return client
    known = [
        ((c.get("client_info") or {}).get("android_client_info") or {}).get("package_name")
        for c in clients
    ]
    fail(
        f"no client for package_name {package!r} in google-services.json "
        f"(clients: {', '.join(str(k) for k in known) or 'none'})",
        2,
    )
    raise AssertionError("unreachable")


def web_client_id(client: dict) -> str | None:
    for oauth in client.get("oauth_client") or []:
        # 3 == WEB client id, the value Google Sign-In expects in default_web_client_id.
        if oauth.get("client_type") == 3 and oauth.get("client_id"):
            return oauth["client_id"]
    return None


def main() -> None:
    if len(sys.argv) < 3:
        fail(__doc__.strip().splitlines()[-1])
    source, res_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    package = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_PACKAGE

    try:
        document = json.loads(source.read_text())
    except FileNotFoundError:
        fail(f"{source} does not exist — decode GOOGLE_SERVICES_JSON first", 2)
    except json.JSONDecodeError as error:
        fail(f"{source} is not valid JSON: {error}", 2)

    project = document.get("project_info") or {}
    client = pick_client(document, package)
    client_info = client.get("client_info") or {}
    api_key = (client.get("api_key") or [{}])[0].get("current_key")

    values = {
        # The Firebase app this APK talks as: must be the one registered for this package name.
        "google_app_id": client_info.get("mobilesdk_app_id"),
        # FCM derives the registration audience from the sender id.
        "gcm_defaultSenderId": project.get("project_number"),
        # Needed by FirebaseApp even when nothing calls a REST API directly.
        "google_api_key": api_key,
        # Read by the app's own troubleshooting screen, and the value the CI check looks for.
        "project_id": project.get("project_id"),
    }
    # Optional in google-services.json and harmless when absent: upstream's library already ships
    # values for these and the overlay simply leaves them alone then.
    optional = {
        "google_storage_bucket": project.get("storage_bucket"),
        "firebase_database_url": project.get("firebase_url"),
        "default_web_client_id": web_client_id(client),
    }
    values.update({k: v for k, v in optional.items() if v})

    missing = [name for name in REQUIRED if not values.get(name)]
    if missing:
        fail(f"{source} has no {', '.join(missing)} for {package}", 3)

    header = [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<!-- Generated at build time by element-x/scripts/firebase-resources.py from the",
        f"     GOOGLE_SERVICES_JSON secret (package {package}, project {values['project_id']}).",
        "     Do not commit: it is written into the upstream checkout by the workflow. -->",
        '<resources xmlns:tools="http://schemas.android.com/tools">',
    ]
    body = [
        f'    <string name="{sax.escape(name)}" translatable="false" '
        f'tools:ignore="UnusedResources">{sax.escape(str(value))}</string>'
        for name, value in values.items()
    ]
    values_file = res_dir / "values" / "firebase.xml"
    values_file.parent.mkdir(parents=True, exist_ok=True)
    values_file.write_text("\n".join(header + body + ["</resources>", ""]))

    # Resource shrinking is on in release (AGP 9.3: optimization { enable = true } implies it) and
    # these strings are only ever read through Resources.getIdentifier(), so the shrinker would drop
    # them without an explicit keep.
    keep = ",".join(f"@string/{name}" for name in values)
    keep_file = res_dir / "raw" / "keep.xml"
    keep_file.parent.mkdir(parents=True, exist_ok=True)
    keep_file.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="utf-8"?>',
                "<!-- Generated at build time: release builds shrink resources, and Firebase reads",
                "     these strings by name through getIdentifier(), which the shrinker cannot see.",
                "     Without the keep list the app installs, launches, and never gets an FCM token. -->",
                '<resources xmlns:tools="http://schemas.android.com/tools"',
                f'    tools:keep="{keep}" />',
                "",
            ]
        )
    )

    print(f"wrote {values_file} and {keep_file}")
    print(f"  package:    {package}")
    print(f"  project_id: {values['project_id']}")
    print(f"  sender id:  {values['gcm_defaultSenderId']}")
    print(f"  resources:  {', '.join(values)}")


if __name__ == "__main__":
    main()
