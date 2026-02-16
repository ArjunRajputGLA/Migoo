"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const supabase_js_1 = require("@supabase/supabase-js");
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase credentials in environment variables.");
    process.exit(1);
}
const supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseKey);
// Ensure temp directory exists
const tempDir = path_1.default.join(__dirname, 'temp');
if (!fs_1.default.existsSync(tempDir)) {
    fs_1.default.mkdirSync(tempDir);
}
app.post('/clip', async (req, res) => {
    const { inputUrl, startTime, endTime, fileName } = req.body;
    if (!inputUrl || startTime === undefined || endTime === undefined || !fileName) {
        return res.status(400).json({ error: "Missing required parameters: inputUrl, startTime, endTime, fileName" });
    }
    const tempInput = path_1.default.join(tempDir, `input_${Date.now()}.mp4`);
    const tempOutput = path_1.default.join(tempDir, `output_${Date.now()}.mp4`);
    try {
        console.log(`[worker] Processing clip: ${fileName} (${startTime}s - ${endTime}s)`);
        // 1. Download video
        console.log(`[worker] Downloading from ${inputUrl}...`);
        const response = await fetch(inputUrl);
        if (!response.ok)
            throw new Error(`Failed to fetch video: ${response.statusText}`);
        const buffer = await response.arrayBuffer();
        fs_1.default.writeFileSync(tempInput, Buffer.from(buffer));
        console.log(`[worker] Saved to ${tempInput}`);
        // 2. Run FFmpeg
        // -ss (start) -to (end) -i (input) 
        // -vf ... (scale to 9:16 vertical 1080x1920)
        // -c:v libx264 -c:a aac -preset fast
        // Calculate 9:16 aspect ratio scaling and padding
        // force_original_aspect_ratio=decrease ensures the video fits within 1080x1920
        // pad ensures the output is exactly 1080x1920 with black bars if needed
        const filterComplex = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";
        const command = `ffmpeg -ss ${startTime} -to ${endTime} -i "${tempInput}" -vf "${filterComplex}" -c:v libx264 -c:a aac -preset fast -y "${tempOutput}"`;
        console.log(`[worker] Running FFmpeg: ${command}`);
        await execAsync(command);
        console.log(`[worker] FFmpeg execution complete`);
        // 3. Upload to Supabase
        console.log(`[worker] Uploading to processed-videos...`);
        const fileContent = fs_1.default.readFileSync(tempOutput);
        // Check local file size
        const stats = fs_1.default.statSync(tempOutput);
        console.log(`[worker] Output file size: ${stats.size} bytes`);
        const { data, error } = await supabase.storage
            .from('processed-videos')
            .upload(fileName, fileContent, {
            contentType: 'video/mp4',
            upsert: true
        });
        if (error) {
            console.error("[worker] Upload error:", error);
            throw error;
        }
        // 4. Get Public URL
        const { data: publicUrlData } = supabase.storage
            .from('processed-videos')
            .getPublicUrl(fileName);
        const clippedUrl = publicUrlData.publicUrl;
        console.log(`[worker] Success! Clipped URL: ${clippedUrl}`);
        // Cleanup
        if (fs_1.default.existsSync(tempInput))
            fs_1.default.unlinkSync(tempInput);
        if (fs_1.default.existsSync(tempOutput))
            fs_1.default.unlinkSync(tempOutput);
        return res.json({ clippedUrl });
    }
    catch (error) {
        console.error("[worker] Error processing clip:", error);
        // Cleanup on error
        if (fs_1.default.existsSync(tempInput))
            fs_1.default.unlinkSync(tempInput);
        if (fs_1.default.existsSync(tempOutput))
            fs_1.default.unlinkSync(tempOutput);
        return res.status(500).json({ error: error.message, stderr: error.stderr });
    }
});
app.post('/extract-audio', async (req, res) => {
    const { inputUrl } = req.body;
    if (!inputUrl) {
        return res.status(400).json({ error: "Missing required parameter: inputUrl" });
    }
    const tempInput = path_1.default.join(tempDir, `audio_input_${Date.now()}.mp4`);
    const tempOutput = path_1.default.join(tempDir, `audio_output_${Date.now()}.wav`);
    // Unique filename for storage
    const storageFileName = `audio_${Date.now()}.wav`;
    try {
        console.log(`[worker] Extracting audio from: ${inputUrl}`);
        // 1. Download video
        console.log(`[worker] Downloading...`);
        const response = await fetch(inputUrl);
        if (!response.ok)
            throw new Error(`Failed to fetch video: ${response.statusText}`);
        const buffer = await response.arrayBuffer();
        fs_1.default.writeFileSync(tempInput, Buffer.from(buffer));
        // 2. Run FFmpeg (extract audio: pcm_s16le, 16kHz, mono)
        const command = `ffmpeg -i "${tempInput}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${tempOutput}"`;
        console.log(`[worker] Running FFmpeg: ${command}`);
        await execAsync(command);
        console.log(`[worker] Audio extraction complete`);
        // 3. Check file size
        const stats = fs_1.default.statSync(tempOutput);
        console.log(`[worker] Audio file size: ${stats.size} bytes`);
        if (stats.size < 1024) { // Warning if < 1KB
            console.warn("[worker] Extracted audio is very small!");
        }
        // 4. Upload to Supabase
        console.log(`[worker] Uploading to processed-videos as ${storageFileName}...`);
        const fileContent = fs_1.default.readFileSync(tempOutput);
        const { data, error } = await supabase.storage
            .from('processed-videos')
            .upload(storageFileName, fileContent, {
            contentType: 'audio/wav',
            upsert: true
        });
        if (error) {
            console.error("[worker] Upload error:", error);
            throw error;
        }
        // 5. Get Public URL
        const { data: publicUrlData } = supabase.storage
            .from('processed-videos')
            .getPublicUrl(storageFileName);
        const audioUrl = publicUrlData.publicUrl;
        console.log(`[worker] Success! Audio URL: ${audioUrl}`);
        // Cleanup
        if (fs_1.default.existsSync(tempInput))
            fs_1.default.unlinkSync(tempInput);
        if (fs_1.default.existsSync(tempOutput))
            fs_1.default.unlinkSync(tempOutput);
        return res.json({ audioUrl });
    }
    catch (error) {
        console.error("[worker] Error extracting audio:", error);
        // Cleanup on error
        if (fs_1.default.existsSync(tempInput))
            fs_1.default.unlinkSync(tempInput);
        if (fs_1.default.existsSync(tempOutput))
            fs_1.default.unlinkSync(tempOutput);
        return res.status(500).json({ error: error.message, stderr: error.stderr });
    }
});
app.listen(PORT, () => {
    console.log(`FFmpeg worker running on http://localhost:${PORT}`);
}); 