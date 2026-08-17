const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const execPromise = promisify(exec);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing Supabase admin environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getFontPath() {
  const winFont = 'C:\\Windows\\Fonts\\arial.ttf';
  if (fs.existsSync(winFont)) {
    return winFont;
  }
  const linuxFonts = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
  ];
  for (const f of linuxFonts) {
    if (fs.existsSync(f)) {
      return f;
    }
  }
  return null;
}

function getEscapedFontFileParam() {
  const fontPath = getFontPath();
  if (!fontPath) return '';

  const localFontName = 'delt_temp_font.ttf';
  const localFontPath = path.join(process.cwd(), localFontName);

  if (!fs.existsSync(localFontPath) && fs.existsSync(fontPath)) {
    try {
      fs.copyFileSync(fontPath, localFontPath);
      console.log(`[VIDEO_PREVIEW] Copied system font to local path: ${localFontPath}`);
    } catch (err) {
      console.warn('[VIDEO_PREVIEW] Failed to copy font file to local directory:', err);
    }
  }

  if (fs.existsSync(localFontPath)) {
    return `:fontfile='${localFontName}'`;
  }
  return '';
}

function getWatermarkFilter() {
  const text = 'DELT PREVIEW';
  const fontSize = 18;
  const stepX = 220;
  const stepY = 120;
  const fontParam = getEscapedFontFileParam();

  const drawtextFilters = [];
  for (let y = 30; y < 480; y += stepY) {
    const isEven = Math.round(y / stepY) % 2 === 0;
    const xOffset = isEven ? 0 : Math.round(stepX / 2);
    for (let x = 30; x < 854; x += stepX) {
      const escapedText = text.replace(/'/g, "'\\\\\\''").replace(/:/g, '\\\\:');
      drawtextFilters.push(
        `drawtext=text='${escapedText}':fontcolor=0x464646@0.0:borderw=1.5:bordercolor=0x464646@0.35:fontsize=dotsize${fontSize}${fontParam}:x=${x + xOffset}:y=${y}`
      );
    }
  }
  return drawtextFilters.join(',');
}

async function generateVideoPreview(dealId, fileVersionId, fileId) {
  const admin = createAdminClient();
  let tempOutPath = null;

  try {
    console.log(`[VIDEO_PREVIEW] Starting generation for deal=${dealId}, version=${fileVersionId}, file=${fileId}`);

    const { data: versionRecord, error: fetchErr } = await admin
      .from('file_versions')
      .select('*')
      .eq('id', fileVersionId)
      .eq('deal_id', dealId)
      .maybeSingle();

    if (fetchErr || !versionRecord) {
      throw new Error(`File version ${fileVersionId} not found: ${fetchErr?.message}`);
    }

    const files = Array.isArray(versionRecord.files) ? versionRecord.files : [];
    const fileIndex = files.findIndex((f) => f.id === fileId);
    if (fileIndex === -1) {
      throw new Error(`File ${fileId} not found in version ${fileVersionId}`);
    }

    const fileItem = files[fileIndex];

    if (fileItem.previewStatus === 'ready' && fileItem.previewPath) {
      console.log(`[VIDEO_PREVIEW] Preview already exists for file=${fileId}. Skipping.`);
      return;
    }

    const filesWithProcessing = [...files];
    filesWithProcessing[fileIndex] = {
      ...fileItem,
      previewStatus: 'processing',
    };

    await admin
      .from('file_versions')
      .update({ files: filesWithProcessing })
      .eq('id', fileVersionId);

    const { data: signedUrlData, error: signError } = await admin.storage
      .from('deal-files')
      .createSignedUrl(fileItem.path, 120);

    if (signError || !signedUrlData?.signedUrl) {
      throw new Error(`Failed to generate signed url for original video: ${signError?.message}`);
    }

    const signedUrl = signedUrlData.signedUrl;

    console.log('[VIDEO_PREVIEW] Querying video duration with ffprobe...');
    const ffprobeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${signedUrl}"`;
    const { stdout: ffprobeStdout } = await execPromise(ffprobeCmd);
    const duration = parseFloat(ffprobeStdout.trim());
    
    if (isNaN(duration) || duration <= 0) {
      throw new Error(`Failed to determine valid video duration: ${ffprobeStdout}`);
    }

    console.log(`[VIDEO_PREVIEW] Original video duration detected: ${duration}s`);

    let previewStart = 0;
    let previewDuration = duration;

    if (duration > 15) {
      const maxDuration = Math.min(20, duration);
      previewDuration = 15 + Math.random() * (maxDuration - 15);
      previewStart = Math.random() * (duration - previewDuration);
      
      previewDuration = Math.round(previewDuration * 100) / 100;
      previewStart = Math.round(previewStart * 100) / 100;
    }

    console.log(`[VIDEO_PREVIEW] Selected rules: start=${previewStart}s, duration=${previewDuration}s`);

    const tempDir = os.tmpdir();
    tempOutPath = path.join(tempDir, `preview_${dealId}_${fileId}_${Date.now()}.mp4`);
    
    const watermarkFilter = getWatermarkFilter();
    const filterGraph = `scale=-2:480,${watermarkFilter}`;

    console.log('[VIDEO_PREVIEW] Executing FFmpeg processing...');
    const ffmpegCmd = `ffmpeg -y -ss ${previewStart} -t ${previewDuration} -i "${signedUrl}" -vf "${filterGraph}" -b:v 500k -maxrate 750k -bufsize 1000k -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 96k -map 0:v:0 -map 0:a? "${tempOutPath}"`;
    
    await execPromise(ffmpegCmd);

    if (!fs.existsSync(tempOutPath)) {
      throw new Error('FFmpeg completed execution but output preview file was not created.');
    }

    const previewStats = fs.statSync(tempOutPath);
    console.log(`[VIDEO_PREVIEW] Output preview file size: ${previewStats.size} bytes`);

    const versionNum = versionRecord.version || 1;
    const cleanPreviewName = fileItem.name.replace(/\.[^.]+$/, '_preview.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
    const previewPath = `previews/${dealId}/v${versionNum}/${Date.now()}_${cleanPreviewName}`;

    const previewBuffer = fs.readFileSync(tempOutPath);

    console.log(`[VIDEO_PREVIEW] Uploading preview copy to deal-files storage path=${previewPath}...`);
    const { error: uploadError } = await admin.storage
      .from('deal-files')
      .upload(previewPath, previewBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload preview to storage: ${uploadError.message}`);
    }

    const filesWithReady = [...files];
    filesWithReady[fileIndex] = {
      ...fileItem,
      previewPath,
      previewType: 'video/mp4',
      previewStatus: 'ready',
      previewGeneratedAt: new Date().toISOString(),
      previewStart,
      previewDuration,
    };

    const { error: updateError } = await admin
      .from('file_versions')
      .update({ files: filesWithReady })
      .eq('id', fileVersionId);

    if (updateError) {
      throw new Error(`Failed to update DB metadata to ready: ${updateError.message}`);
    }

    console.log(`[VIDEO_PREVIEW] Generation complete and saved successfully for file=${fileId}!`);

  } catch (error) {
    console.error(`[VIDEO_PREVIEW] Error occurred:`, error);

    try {
      const { data: currentVersion } = await admin
        .from('file_versions')
        .select('*')
        .eq('id', fileVersionId)
        .maybeSingle();

      if (currentVersion) {
        const curFiles = Array.isArray(currentVersion.files) ? currentVersion.files : [];
        const fIdx = curFiles.findIndex((f) => f.id === fileId);
        if (fIdx !== -1) {
          const updatedFiles = [...curFiles];
          updatedFiles[fIdx] = {
            ...updatedFiles[fIdx],
            previewStatus: 'failed',
            previewGeneratedAt: new Date().toISOString(),
          };
          await admin
            .from('file_versions')
            .update({ files: updatedFiles })
            .eq('id', fileVersionId);
        }
      }
    } catch (dbErr) {
      console.error('[VIDEO_PREVIEW] Double fault: Failed to mark file status as failed in DB:', dbErr);
    }

  } finally {
    if (tempOutPath && fs.existsSync(tempOutPath)) {
      try {
        fs.unlinkSync(tempOutPath);
        console.log(`[VIDEO_PREVIEW] Cleaned up temp file: ${tempOutPath}`);
      } catch (cleanupErr) {
        console.error(`[VIDEO_PREVIEW] Failed to delete temp file ${tempOutPath}:`, cleanupErr);
      }
    }
  }
}

const authenticate = (req, res, next) => {
  const secret = process.env.VIDEO_PROCESSOR_SECRET;
  if (!secret) {
    console.warn('[VIDEO_PROCESSOR] Warning: VIDEO_PROCESSOR_SECRET environment variable is not set. Allowing unauthenticated request.');
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== secret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
};

app.get('/health', async (req, res) => {
  let ffmpeg = false;
  let ffprobe = false;
  try {
    await execPromise('ffmpeg -version');
    ffmpeg = true;
  } catch (e) {}
  try {
    await execPromise('ffprobe -version');
    ffprobe = true;
  } catch (e) {}

  res.json({
    status: "ok",
    ffmpeg,
    ffprobe
  });
});

app.post('/process', authenticate, async (req, res) => {
  const { dealId, fileVersionId, fileId } = req.body;
  if (!dealId || !fileVersionId || !fileId) {
    return res.status(400).json({ error: 'Missing required parameters: dealId, fileVersionId, fileId' });
  }

  // Trigger processing asynchronously
  generateVideoPreview(dealId, fileVersionId, fileId).catch(err => {
    console.error('Asynchronous video processing failed:', err);
  });

  res.json({ success: true, message: 'Video preview processing started' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video processor listening on port ${PORT}`);
});
