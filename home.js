/*
  QuorumCivic landing page behavior: the ZIP delegation block and the mobile
  sticky store bar.

  The ZIP block gives the page a question only the app fully answers. The
  lookup calls the share-domain API (CORS is granted to quorumcivic.app and
  www.quorumcivic.app on exactly this route); the call is stateless and the
  ZIP is never stored or logged server-side. The browser remembers it in
  localStorage (qc_zip) so a returning visitor sees their members without
  retyping. No event ever carries the ZIP or any location property; that is
  a privacy contract shared with the share pages, not an oversight.

  Store-button clicks here are NOT tracked in this file. Every store link on
  the page carries data-store/data-placement, and analytics.js owns the
  store_link_click event plus the per-placement campaign tokens.
*/
(function () {
  'use strict';

  var API = 'https://share.quorumcivic.app/api/district/by-zip?zip=';
  var ZIP_KEY = 'qc_zip';

  function capture(event, props) {
    if (window.posthog && typeof window.posthog.capture === 'function') {
      window.posthog.capture(event, props || {});
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Finding hero: the feed's #1 story ─────────────────────────────────────
  // Opens the page with a specific finding instead of the product pitch
  // (docs/strategy/pivot_2026-08.md §3 in the quorum repo; the 2026-08-18
  // traffic analysis measured receipts holding 50% of readers vs 2.8% here).
  // The API returns the same fields the /s/ receipt page renders, so the hero
  // and its destination cannot disagree. Every failure path leaves the static
  // pitch as the hero. The receipt link carries explicit utm_ params — the
  // receipt page's attribution gives URL utm_source absolute precedence, so
  // hero-driven deep-reads land in their own bucket with no ?s= vocabulary
  // change on either host.
  (function () {
    var block = document.getElementById('hero-finding');
    if (!block) return;

    fetch('https://share.quorumcivic.app/api/feed/top-story')
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
      .then(function (data) {
        var s = data && data.story;
        if (!s || !s.headline || !s.receipt_url) return;

        document.getElementById('finding-headline').textContent = s.headline;

        var dek = document.getElementById('finding-dek');
        if (s.dek) { dek.textContent = s.dek; } else { dek.hidden = true; }

        if (s.eyebrow) {
          document.getElementById('finding-eyebrow').textContent =
            'This week\'s finding · ' + s.eyebrow;
        }

        document.getElementById('finding-source').textContent =
          (s.subhead ? s.subhead + ' · ' : '')
          + 'From the public record of the 119th Congress';

        var link = document.getElementById('finding-link');
        link.href = s.receipt_url
          + (s.receipt_url.indexOf('?') === -1 ? '?' : '&')
          + 'utm_source=quorumcivic.app&utm_medium=apex_hero';
        link.addEventListener('click', function () {
          capture('web_hero_finding_click', { story_uid: s.story_uid });
        });

        block.hidden = false;
        var pitch = document.getElementById('hero-pitch');
        if (pitch) pitch.classList.add('demoted');
        capture('web_hero_finding_shown', { story_uid: s.story_uid });
      })
      .catch(function () { /* static pitch stays the hero */ });
  })();

  // ── ZIP block: who represents you ─────────────────────────────────────────
  (function () {
    var block = document.getElementById('zip-block');
    if (!block) return;
    var form = document.getElementById('zip-form');
    var input = document.getElementById('zip-input');
    var out = document.getElementById('zip-out');
    var cta = document.getElementById('zip-cta');
    var ctaLine = document.getElementById('zip-cta-line');

    function savedZip() {
      try { return window.localStorage.getItem(ZIP_KEY) || ''; } catch (e) { return ''; }
    }
    function saveZip(z) {
      try { window.localStorage.setItem(ZIP_KEY, z); } catch (e) {}
    }

    // Party dots keep the party word in the adjacent text, never color alone.
    // The general lookup returns party for senators only, so representative
    // rows carry the neutral dot rather than a guessed color.
    function dotClass(party) {
      var initial = String(party || '').charAt(0).toUpperCase();
      return initial === 'D' || initial === 'R' || initial === 'I' ? ' ' + initial : '';
    }

    function repSeat(d) {
      var atLarge = d.district === '0' || d.district === 'At-Large';
      return d.state + (atLarge ? ' At-Large' : '-' + d.district) + ' &middot; Representative';
    }

    function render(data) {
      var reps = (data.districts || []).filter(function (d) { return d.display_name; });
      var senators = (data.senators || []).filter(function (s) { return s.display_name; });

      var html = '<div class="zip-rows">';
      reps.forEach(function (d) {
        html += '<div class="zip-row"><span class="pdot"></span>'
          + '<div class="zip-who"><b>' + esc(d.display_name) + '</b> '
          + '<span class="seat">' + repSeat({ state: esc(d.state), district: esc(d.district) }) + '</span></div></div>';
      });
      senators.forEach(function (s) {
        html += '<div class="zip-row"><span class="pdot' + dotClass(s.party) + '"></span>'
          + '<div class="zip-who"><b>' + esc(s.display_name) + '</b> '
          + '<span class="seat">' + esc(s.party ? s.party + ' · ' : '') + esc(s.state) + ' &middot; Senator</span></div></div>';
      });
      html += '</div>';

      var ctx = [];
      if (reps.length > 1) {
        ctx.push('This ZIP crosses district lines, so every representative it touches is shown.');
      }
      if (!reps.length) {
        ctx.push('No representative came back for this ZIP; both senators still did.');
      }
      ctx.push('From the congressional record of the 119th Congress (2025&ndash;2027).');
      html += '<div class="zip-ctx">' + ctx.join('<br>') + '</div>';
      out.innerHTML = html;

      ctaLine.textContent = reps.length === 1
        ? 'Every vote ' + reps[0].display_name + ' has cast, plus their funders and trades, free in the app.'
        : 'Every vote your members cast, plus their funders and trades, free in the app.';
      cta.hidden = false;
    }

    function lookup(z, auto) {
      out.innerHTML = '<p class="zip-note">Looking up&hellip;</p>';
      fetch(API + encodeURIComponent(z))
        .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
        .then(function (data) {
          var members = (data.districts || []).length + (data.senators || []).length;
          capture('web_zip_resolved', {
            found: members > 0,
            members: members,
            multi_district: (data.districts || []).length > 1,
            auto: !!auto
          });
          if (!members) {
            out.innerHTML = '<p class="zip-err">That ZIP didn\'t match a congressional district.</p>';
            cta.hidden = true;
            return;
          }
          saveZip(z);
          render(data);
        })
        .catch(function () {
          out.innerHTML = '<p class="zip-err">The lookup didn\'t go through. Try again.</p>';
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var z = (input.value || '').replace(/\D/g, '');
      if (z.length !== 5) {
        out.innerHTML = '<p class="zip-err">A ZIP is five digits.</p>';
        return;
      }
      capture('web_zip_submitted');
      lookup(z, false);
    });

    // A visitor who already told us their ZIP sees their members immediately.
    var remembered = savedZip();
    if (/^\d{5}$/.test(remembered)) {
      input.value = remembered;
      lookup(remembered, true);
    }
  })();

  // ── Sticky store bar ──────────────────────────────────────────────────────
  // Appears only after real scroll, and steps aside whenever any other store
  // button is on screen, so CTAs never stack. The header pill counts: it sits
  // in the sticky header, so on screens wide enough to show it this bar stays
  // down permanently, and the bar effectively serves phones only. Plain rect
  // math on scroll rather than IntersectionObserver: one pass per scroll event
  // on a static page costs nothing, and observers don't deliver when the page
  // is backgrounded.
  (function () {
    var bar = document.getElementById('sticky-bar');
    if (!bar) return;
    var scrolledEnough = false;

    function otherStoreButtonOnScreen() {
      var links = document.querySelectorAll('a[data-store]');
      for (var i = 0; i < links.length; i++) {
        var el = links[i];
        if (bar.contains(el) || el.offsetParent === null) continue;
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) return true;
      }
      return false;
    }

    function sync() {
      if (!scrolledEnough) {
        scrolledEnough =
          window.scrollY > Math.min(600, document.body.scrollHeight * 0.3);
      }
      var show = scrolledEnough && !otherStoreButtonOnScreen();
      bar.classList.toggle('show', show);
      bar.setAttribute('aria-hidden', show ? 'false' : 'true');
      document.body.classList.toggle('has-sticky', show);
    }

    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync, { passive: true });
  })();
})();
