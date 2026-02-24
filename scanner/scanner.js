(function(){
  'use strict';

  var qs = new URLSearchParams(window.location.search || '');
  var origin = (qs.get('origin') || '*').trim();
  var state = (qs.get('state') || '').trim();
  var flow = (qs.get('flow') || 'checkin').trim();

  var video = document.getElementById('video');
  var statusEl = document.getElementById('status');
  var btnRetry = document.getElementById('btnRetry');
  var btnCancel = document.getElementById('btnCancel');

  var scanner = {
    stream:null,
    raf:null,
    detector:null,
    scanning:false,
    canvas:null,
    ctx:null
  };

  function setStatus(msg){
    statusEl.textContent = msg || '';
  }

  function canPostToOpener(){
    return !!(window.opener && !window.opener.closed);
  }

  function safeOrigin(){
    return origin || '*';
  }

  function openerMissingNotice(extra){
    var lines = ['無法回傳到原頁面（找不到 opener）。 / Unable to return result (no opener found).'];
    if(extra) lines.push(String(extra));
    setStatus(lines.join(' '));
  }

  function postToOpener(type, payload, detail){
    if(!canPostToOpener()) return;
    var message = { type:type, state:state, flow:flow };
    if(typeof payload !== 'undefined') message.payload = payload;
    if(typeof detail !== 'undefined') message.detail = detail;

    try{
      window.opener.postMessage(message, safeOrigin());
    }catch(err){
      try{
        window.opener.postMessage({
          type:'CCF_QR_ERROR',
          state:state,
          flow:flow,
          detail: String((err && err.message) || err || 'postMessage failed')
        }, '*');
      }catch(e){}
    }
  }

  function stopScan(){
    scanner.scanning = false;
    if(scanner.raf){
      cancelAnimationFrame(scanner.raf);
      scanner.raf = null;
    }
    if(scanner.stream){
      scanner.stream.getTracks().forEach(function(track){ track.stop(); });
      scanner.stream = null;
    }
  }

  function finishSuccess(payload){
    stopScan();
    if(!canPostToOpener()){
      openerMissingNotice('已掃描：' + String(payload || ''));
      return;
    }
    postToOpener('CCF_QR_RESULT', payload);
    window.close();
  }

  function finishCancel(detail){
    stopScan();
    if(!canPostToOpener()){
      openerMissingNotice('已取消掃描。 / Scan cancelled.');
      return;
    }
    postToOpener('CCF_QR_CANCEL', undefined, detail || 'cancelled');
    window.close();
  }

  function finishError(detail){
    stopScan();
    if(!canPostToOpener()){
      openerMissingNotice('相機錯誤：' + String(detail || 'unknown error'));
      return;
    }
    postToOpener('CCF_QR_ERROR', undefined, detail);
  }

  function loop(){
    if(!scanner.scanning) return;

    if(!video || video.readyState < 2){
      scanner.raf = requestAnimationFrame(loop);
      return;
    }

    try{
      if('BarcodeDetector' in window){
        scanner.detector = scanner.detector || new BarcodeDetector({ formats:['qr_code'] });
        scanner.detector.detect(video).then(function(codes){
          var value = (codes && codes.length && codes[0].rawValue) ? codes[0].rawValue : null;
          if(value){
            finishSuccess(value);
            return;
          }
          scanner.raf = requestAnimationFrame(loop);
        }).catch(function(){
          scanner.raf = requestAnimationFrame(loop);
        });
        return;
      }
    }catch(err){}

    try{
      scanner.canvas = scanner.canvas || document.createElement('canvas');
      scanner.ctx = scanner.ctx || scanner.canvas.getContext('2d', { willReadFrequently:true });
      scanner.canvas.width = video.videoWidth;
      scanner.canvas.height = video.videoHeight;
      scanner.ctx.drawImage(video, 0, 0, scanner.canvas.width, scanner.canvas.height);
      var img = scanner.ctx.getImageData(0, 0, scanner.canvas.width, scanner.canvas.height);
      if(window.jsQR){
        var qr = window.jsQR(img.data, scanner.canvas.width, scanner.canvas.height);
        if(qr && qr.data){
          finishSuccess(qr.data);
          return;
        }
      }
    }catch(err){}

    scanner.raf = requestAnimationFrame(loop);
  }

  function startScan(){
    stopScan();
    setStatus('啟動相機中... / Starting camera...');

    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      var unsupportedDetail = 'Camera not supported on this device/browser';
      setStatus('此裝置不支援相機 / Camera not supported');
      finishError(unsupportedDetail);
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ ideal:'environment' } },
      audio:false
    }).then(function(stream){
      scanner.stream = stream;
      video.srcObject = stream;
      return video.play();
    }).then(function(){
      scanner.scanning = true;
      setStatus('請對準 QR 碼 / Align the QR code');
      loop();
    }).catch(function(err){
      var detail = String((err && (err.name + (err.message ? (': ' + err.message) : ''))) || 'Camera start failed');
      setStatus('相機無法啟動 / Camera cannot start');
      finishError(detail);
    });
  }

  btnRetry.addEventListener('click', startScan);
  btnCancel.addEventListener('click', function(){ finishCancel('user_cancelled'); });
  window.addEventListener('beforeunload', function(){ stopScan(); });

  if(!canPostToOpener()) openerMissingNotice('請返回原頁面重新開啟掃描器。 / Please return to the portal and reopen scanner.');
  startScan();
})();
