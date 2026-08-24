/*
  QuorumCivic apex analytics: pageview source labeling plus store-link
  attribution. Two jobs, one channel vocabulary.

  1. Pageview source labeling. Profile links in social bios use short typable
     tags (quorumcivic.app/?s=yt) because a bio line has no room for
     utm_source. This script maps the tag onto utm_source/utm_medium, writes
     them into the page's own URL, and THEN captures $pageview by hand, so
     posthog-js picks the label up through its native campaign-param path.
     The pages init PostHog with the automatic pageview off (it fires during
     init(), before this script runs). Why the URL and not register(): see the
     comment above capturePageview().

  2. Store-link attribution. Carries the landing page's campaign signal
     through to the App Store and Google Play links, and mirrors the same
     values onto a PostHog event so all three reports share one join key.

     Join key is campaign_token, for example "web-hero-reddit":
       Apple        ct=<token>           App Store Connect > App Analytics > Campaigns
       Google Play  utm_content=<token>  inside the install referrer string
       PostHog      campaign_token       property on the store_link_click event

     Links carry a working ...-direct token in their markup, so the tokens
     stay valid if this script never runs. It only upgrades them in place.

  Precedence, same for both jobs and same as the share host: an explicit
  utm_source on the URL, then our ?s= tag (utm_medium social), then an
  ad-platform click id (utm_medium referral), then the referrer host.
*/
(function () {
  'use strict';

  var SITE_SOURCE = 'quorumcivic.app';
  var SITE_MEDIUM = 'website';
  var STORAGE_KEY = 'qc_attribution';
  var DEFAULT_CHANNEL = 'direct';
  var TOKEN_MAX = 40; // Apple truncates campaign tokens past 40 characters
  var VALUE_MAX = 120;

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  // The ?s= tag vocabulary. Must stay identical to the share host's copy in
  // the quorum repo (web/templates/receipt.html); it has drifted across files
  // twice already (li, then fbp), and a drifted tag registers nothing.
  var SRC = { ig: 'instagram', th: 'threads', bs: 'bluesky',
              yt: 'youtube', tt: 'tiktok', fb: 'facebook',
              li: 'linkedin', fbp: 'facebook_page', rd: 'reddit' };

  // Ad-platform click ids, used to name the channel when no utm_source or ?s=
  // tag is present. Values normalise onto the SRC vocabulary above, same as
  // the share host, so one channel is one bucket across hosts. Caveat: every
  // Meta app appends fbclid, and the new-format token encodes which one, so
  // read "facebook via click id" as "some Meta app", not Facebook proper.
  var CLICK_IDS = { fbclid: 'facebook', gclid: 'google', gbraid: 'google',
                    wbraid: 'google', msclkid: 'bing', ttclid: 'tiktok',
                    twclid: 'x', li_fat_id: 'linkedin' };

  // Referrer hosts, normalised onto the same vocabulary. Unlisted hosts pass
  // through as their bare hostname.
  var REF_HOSTS = {
    'facebook.com': 'facebook', 'm.facebook.com': 'facebook',
    'l.facebook.com': 'facebook', 'lm.facebook.com': 'facebook',
    'linkedin.com': 'linkedin', 'lnkd.in': 'linkedin',
    'com.linkedin.android': 'linkedin',
    'google.com': 'google', 'bing.com': 'bing', 'duckduckgo.com': 'duckduckgo',
    'instagram.com': 'instagram', 'l.instagram.com': 'instagram',
    't.co': 'x', 'x.com': 'x', 'threads.com': 'threads',
    'l.threads.com': 'threads', 'bsky.app': 'bluesky',
    'go.bsky.app': 'bluesky', 'youtube.com': 'youtube',
    'm.youtube.com': 'youtube', 'reddit.com': 'reddit',
    'out.reddit.com': 'reddit', 'tiktok.com': 'tiktok'
  };

  function slug(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Pull campaign signal off the current URL, falling back to the referring host.
  function readLanding() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      return null;
    }

    var attribution = {};
    var found = false;

    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) {
        attribution[key] = value.slice(0, VALUE_MAX);
        found = true;
      }
    });

    // Our own short source tag, second only to an explicit utm_source.
    var tagged = SRC[params.get('s')];
    if (tagged) {
      if (!attribution.utm_source) attribution.utm_source = tagged;
      if (!attribution.utm_medium) attribution.utm_medium = 'social';
      found = true;
    }

    for (var id in CLICK_IDS) {
      if (Object.prototype.hasOwnProperty.call(CLICK_IDS, id) && params.get(id)) {
        attribution.click_id_type = id;
        if (!attribution.utm_source) {
          attribution.utm_source = CLICK_IDS[id];
          if (!attribution.utm_medium) attribution.utm_medium = 'referral';
        }
        found = true;
        break;
      }
    }

    if (found) return attribution;

    // No tagged link, so fall back to the referrer. Same-host navigation between
    // our own pages is not a new touch and is ignored here.
    var host = '';
    try {
      host = new URL(document.referrer).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
      return null;
    }
    if (!host || host === window.location.hostname) return null;

    return { utm_source: REF_HOSTS[host] || host, utm_medium: 'referral', referrer_host: host };
  }

  function load() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function save(attribution) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attribution));
    } catch (e) {
      // Private browsing or storage disabled. In-memory value still works for this page.
    }
  }

  // Last non-direct touch wins. A tagged landing overwrites whatever the session
  // held; an untagged page keeps the stored value so the signal survives an
  // internal hop from the landing page to a page holding a store link.
  function resolve() {
    var landing = readLanding();
    if (landing) {
      save(landing);
      return landing;
    }
    var stored = load();
    if (stored) return stored;

    var fallback = { utm_source: DEFAULT_CHANNEL };
    save(fallback);
    return fallback;
  }

  function channelOf(attribution) {
    return slug(attribution.utm_source) || DEFAULT_CHANNEL;
  }

  function buildToken(placement, attribution) {
    var parts = ['web', slug(placement) || 'unknown', channelOf(attribution)];
    var campaign = slug(attribution.utm_campaign);
    if (campaign && campaign !== parts[2]) parts.push(campaign);
    return parts.join('-').slice(0, TOKEN_MAX).replace(/-+$/, '');
  }

  function decorate(link, attribution) {
    var store = link.getAttribute('data-store');
    var token = buildToken(link.getAttribute('data-placement'), attribution);
    var url;

    try {
      url = new URL(link.href);
    } catch (e) {
      return null;
    }

    if (store === 'app_store') {
      url.searchParams.set('ct', token);
    } else if (store === 'google_play') {
      // Play takes one referrer value holding an encoded utm string. The site is
      // the source of the store visit; what drove the visit to the site rides
      // along in utm_campaign.
      var referrer = new URLSearchParams();
      referrer.set('utm_source', SITE_SOURCE);
      referrer.set('utm_medium', SITE_MEDIUM);
      referrer.set('utm_campaign', slug(attribution.utm_campaign) || channelOf(attribution));
      referrer.set('utm_content', token);
      url.searchParams.set('referrer', referrer.toString());
    } else {
      return null;
    }

    link.href = url.toString();
    return token;
  }

  function track(link, token, attribution) {
    if (!window.posthog || typeof window.posthog.capture !== 'function') return;

    window.posthog.capture(
      'store_link_click',
      {
        store: link.getAttribute('data-store'),
        placement: link.getAttribute('data-placement'),
        campaign_token: token,
        channel: channelOf(attribution),
        landing_utm_source: attribution.utm_source || null,
        landing_utm_medium: attribution.utm_medium || null,
        landing_utm_campaign: attribution.utm_campaign || null,
        landing_utm_content: attribution.utm_content || null,
        landing_utm_term: attribution.utm_term || null,
        landing_click_id_type: attribution.click_id_type || null,
        landing_referrer_host: attribution.referrer_host || null,
        store_url: link.href
      },
      // The click navigates away, so hand the event off in a way that survives unload.
      { send_instantly: true, transport: 'sendBeacon' }
    );
  }

  // Label the pageview, then capture it. Anything that ends up as utm_source
  // is written INTO the page's own URL (replaceState) before the capture —
  // never register()ed. At the first capture posthog-js builds every key on
  // its campaign list as "value or null" whenever ANY campaign parameter is
  // present, and registers that object into session persistence, which
  // outranks register() at merge time. fbclid is on that list and every Meta
  // app appends one, so tagged Threads / Instagram / Facebook taps on
  // /?s=ig&fbclid=... landed as utm_source=None while YouTube (no click id)
  // kept its label. Same fix the share host shipped in receipt.html and
  // beta.html on 2026-08-21 (reproduced and verified against posthog-js
  // 1.418.10 in a local harness there); mechanism and history in the quorum
  // repo's docs/handoff/apex_source_tags_2026-08-20.md addendum. Properties
  // NOT on the campaign list (click_id_type, referrer_host) still register()
  // safely. An explicit utm_source on the URL always wins — this only ever
  // appends when one is absent. On localhost init() is skipped and
  // window.posthog stays a queueing stub, so all of this safely no-ops.
  function capturePageview() {
    var ph = window.posthog;
    if (!ph || typeof ph.register !== 'function' || typeof ph.capture !== 'function') return;

    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      params = null;
    }

    if (params && !params.get('utm_source')) {
      var src = null;
      var medium = null;
      var extra = {};

      var tagged = SRC[params.get('s')];
      if (tagged) {
        // A tag we placed. Highest confidence, and utm_medium 'social' is
        // what separates "we posted this" from "we inferred it".
        src = tagged;
        medium = 'social';
      } else {
        for (var id in CLICK_IDS) {
          if (Object.prototype.hasOwnProperty.call(CLICK_IDS, id) && params.get(id)) {
            src = CLICK_IDS[id];
            medium = 'referral';
            extra.click_id_type = id;
            break;
          }
        }
        if (!src) {
          var host = '';
          try {
            host = new URL(document.referrer).hostname.replace(/^www\./, '').toLowerCase();
          } catch (e) {
            host = '';
          }
          // Same-host navigation is not a new touch.
          if (host && host !== window.location.hostname) {
            src = REF_HOSTS[host] || host;
            medium = 'referral';
            extra.referrer_host = host;
          }
        }
      }

      if (src) {
        var qs = window.location.search
               + (window.location.search ? '&' : '?')
               + 'utm_source=' + encodeURIComponent(src)
               + '&utm_medium=' + encodeURIComponent(medium);
        try {
          window.history.replaceState(window.history.state, '',
            window.location.pathname + qs + window.location.hash);
        } catch (e) { /* the page still works; only the label is lost */ }
        if (extra.click_id_type || extra.referrer_host) ph.register(extra);
      }
    }

    ph.capture('$pageview');
  }

  function init() {
    var attribution = resolve();
    var links = document.querySelectorAll('a[data-store]');

    Array.prototype.forEach.call(links, function (link) {
      var token = decorate(link, attribution);
      if (!token) return;
      link.addEventListener('click', function () {
        track(link, token, attribution);
      });
    });
  }

  capturePageview();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
