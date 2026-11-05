"""Byte-faithful excerpts of the pinned Cinny bundle (lite.plotina.cc
assets/index-DoOJk9D-.js, upstream cinny@1e6412ed via cinny-desktop v4.12.8).

Minified identifiers (qW, w8e, bF, Z3) change with every upstream bump; these
excerpts are snapshots for the theme-default guard in branding.py, exactly
like element-call/tests/fixtures.py does for Element Call.
"""

# The settings defaults object: the only place the theme default lives.
# `useSystemTheme:!0` means a fresh visitor (no localStorage "settings")
# follows prefers-color-scheme: Dark when the system is dark, Light
# otherwise. lightThemeId/darkThemeId are void 0, so the resolution below
# picks the raw Z3/Dark and bF/Light fallbacks.
PROD_SETTINGS_DEFAULTS = 'const qW={themeId:void 0,useSystemTheme:!0,lightThemeId:void 0,darkThemeId:void 0,monochromeMode:!1,isMarkdown:!0,editorToolbar:!1,twitterEmoji:!1,pageZoom:100,hideActivity:!1,isPeopleDrawer:!0,memberSortFilterIndex:0,enterForNewline:!1,messageLayout:0,messageSpacing:"400",hideMembershipEvents:!1,hideNickAvatarEvents:!0,mediaAutoLoad:!0,urlPreview:!0,encUrlPreview:!1,showHiddenEvents:!1,legacyUsernameColor:!1,showNotifications:!0,isNotificationSounds:!0,hour24Clock:!1,dateFormatString:"D MMM YYYY",developerTools:!1}'

# useActiveTheme as shipped: system on => kind-matched theme (`?? Z3` Dark
# for dark, `?? bF` Light for light); system off => themeId, default Light.
PROD_ACTIVE_THEME = 'w8e=()=>{const t=Kj(),e=Wj(),[n]=et(Ze,"useSystemTheme"),[r]=et(Ze,"themeId"),[i]=et(Ze,"lightThemeId"),[o]=et(Ze,"darkThemeId");return n?t==="dark"?e.find(s=>s.id===o)??Z3:e.find(s=>s.id===i)??bF:e.find(s=>s.id===r)??bF}'

# The regression the guard must catch: the default pinned to off, which
# leaves every fresh visitor on a fixed Light theme regardless of the OS.
REGRESSED_SETTINGS_DEFAULTS = PROD_SETTINGS_DEFAULTS.replace(
    "useSystemTheme:!0", "useSystemTheme:!1"
)

# A chunk that does not carry the settings defaults at all (renamed or
# restructured upstream): the guard must refuse instead of silently pass.
NO_DEFAULTS_BUNDLE = "const app=1;"
