
// play_sound.js — attempt to autoplay the ding.wav and close the window after playback.
// It's intentionally tiny and defensive about autoplay rejections.

(async function(){
  try {
    const a = document.getElementById('ding');
    if (!a) return;
    // ensure volume is audible
    a.volume = 1.0;
    // try to play; browsers may block autoplay unless window was created by extension
    const p = a.play();
    if (p && p.then) {
      p.then(() => {
        // close after audio finishes (with a small buffer)
        a.addEventListener('ended', () => {
          try { window.close(); } catch(e) {}
        });
        // fallback: close after 3s
        setTimeout(()=>{ try{ window.close(); } catch(e){} }, 3000);
      }).catch(() => {
        // autoplay blocked; still try to show UI briefly then close
        setTimeout(()=>{ try{ window.close(); } catch(e){} }, 500);
      });
    } else {
      // no promise returned; schedule close
      setTimeout(()=>{ try{ window.close(); } catch(e){} }, 1000);
    }
  } catch (e) {
    try { window.close(); } catch(_) {}
  }
})();
