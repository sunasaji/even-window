// pinhole-window Firefox profile prefs, for the Even G2 through the mirrored desktop: a
// 576x288 screen, 16 levels of green, swipe/tap input.
//
// This is the template: scripts/pw-firefox.sh copies it into the runtime profile on
// every launch, so edits to the runtime copy are lost. Machine-specific prefs (homepage,
// scaling) go in <profile>/user-local.js, which the launcher appends.
// Background: docs/firefox.md.

// ── Enable chrome/userChrome.css ─────────────────────────────────────────────
// It releases the chrome's intrinsic minimum width (638px, wider than the 576px screen)
// and blackens the toolbars.
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// ── Dark chrome ──────────────────────────────────────────────────────────────
// Grey chrome is a permanently lit band on an emissive display. The theme prefs give
// dark grey and userChrome.css makes it black; CSS alone misses some popups.
// activeThemeID does not switch the theme on a fresh profile (the AddonManager resets
// it), so the three prefs after it are what darken the chrome on first run.
user_pref("extensions.activeThemeID", "firefox-compact-dark@mozilla.org");
user_pref("browser.theme.toolbar-theme", 0); // 0 = dark
user_pref("browser.theme.content-theme", 0); // 0 = dark
user_pref("ui.systemUsesDarkTheme", 1);
user_pref("layout.css.prefers-color-scheme.content-override", 0); // 0 = dark
user_pref("browser.uidensity", 1); // compact: less chrome height and less minimum width
user_pref("browser.toolbars.bookmarks.visibility", "never");

// ── Tabs live in the sidebar rail ────────────────────────────────────────────
// The sidebar launcher is on screen by default (36px wide), so tabs in the rail cost
// nothing extra, while a horizontal tab strip costs height, the scarcer axis at 288px.
// The rail also keeps a tab opened by a target="_blank" link visible.
// sidebar.revamp hosts vertical tabs; it is set explicitly so no build leaves them inert.
user_pref("sidebar.revamp", true);
user_pref("sidebar.verticalTabs", true);
// Keep the rail on screen; the point of the rail here is that the tabs are visible.
user_pref("sidebar.visibility", "always-show");
// Start with the rail collapsed. The collapsed state lives in sidebar.backupState, which
// does not exist on a fresh profile, and without it the sidebar opens expanded over
// ~240px. The value is the shape Firefox writes itself. user.js is re-applied on every
// launch, so expanding the rail by hand lasts for that session only.
user_pref("sidebar.backupState", "{\"command\":\"\",\"panelOpen\":false,\"bookmarksExpandedFolders\":[],\"launcherWidth\":0,\"launcherExpanded\":false,\"launcherVisible\":true}");
// The rail is about 8 icons tall at 288px, and every tool icon is one fewer tab.
// History and bookmarks stay because they reach a page without typing a URL.
user_pref("sidebar.main.tools", "history,bookmarks");
// F11 gives the page the full screen: fullscreen hides the rail and the nav toolbar.

// ── Viewport ─────────────────────────────────────────────────────────────────
// meta-viewport stays off: enabling it insets the scrollbar from the right edge and
// leaves a blank gap there. This is independent of the user agent.
user_pref("dom.meta-viewport.enabled", false);

// ── Mobile user agent: off by default ────────────────────────────────────────
// At 576 CSS px a responsive site already serves its one-column layout to a desktop user
// agent. A mobile user agent only changes sites that serve by user agent, and those add
// sticky headers and app banners that cost height. To enable it, uncomment both prefs
// below (or set them in user-local.js); some sites gate their mobile UI on touch events.
// The per-domain form (general.useragent.override.<host>) has no effect, and an empty
// override yields an empty user agent, so disabling means removing the pref.
// pw-firefox.sh strips retired prefs from prefs.js: a pref removed from this file must
// be added to RETIRED_PREFS there to take effect.
//
//
// user_pref("general.useragent.override", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36");
// user_pref("dom.w3c_touch_events.enabled", 1);

// ── Scrollbars: always visible, thin, high contrast ──────────────────────────
// Scrolling is by swipe, so the bar is only a position indicator, and an overlay
// scrollbar that fades out would hide it.
user_pref("widget.gtk.overlay-scrollbars.enabled", false); // classic always-on bars
user_pref("widget.non-native-theme.enabled", true);        // Firefox-drawn, sizable
user_pref("widget.non-native-theme.scrollbar.size.override", 2); // px: a hairline indicator
user_pref("widget.non-native-theme.scrollbar.style", 4);   // always-visible style

// ── Quiet startup ────────────────────────────────────────────────────────────
// Every modal has to be dismissed with a swipe-driven pointer, so a fresh profile must
// boot straight to the page. The "Terms of Use" pre-onboarding modal is separate from
// aboutwelcome: it needs its own pref and a pre-accepted data policy.
user_pref("browser.preonboarding.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("datareporting.policy.dataSubmissionPolicyAcceptedVersion", 2);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 1);            // open the homepage on start
user_pref("browser.newtabpage.enabled", false);  // blank new tab (black via userContent.css)
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("browser.aboutConfig.showWarning", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("full-screen-api.warning.timeout", 0);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.disableResetPrompt", true);

// ── Suppress Firefox's own feature prompts and callouts ──────────────────────
user_pref("browser.translations.automaticallyPopup", false);        // "Try private translations"
user_pref("browser.messaging-system.whatsNewPanel.enabled", false); // What's New panel
user_pref("messaging-system.rsexperimentloader.enabled", false);    // Nimbus experiments
user_pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
user_pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);
user_pref("browser.startup.upgradeDialog.enabled", false);          // milestone dialog
user_pref("browser.vpn_promo.enabled", false);
user_pref("browser.ipProtection.enabled", false);                   // the green "VPN" button
user_pref("browser.promo.focus.enabled", false);
user_pref("extensions.pocket.enabled", false);
user_pref("browser.shopping.experience2023.enabled", false);        // Review Checker
user_pref("identity.fxaccounts.toolbar.enabled", false);
user_pref("browser.preferences.moreFromMozilla", false);

// Marionette stays off: it sets navigator.webdriver, and sites that block automation
// (Google sign-in) then refuse to log in.
