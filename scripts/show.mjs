import { spawn, execSync } from 'child_process';

const isWindows = process.platform === 'win32';
const SESSION = 'stagelinq';

if (!isWindows) {
    // Check if session already exists
    try { execSync(`tmux kill-session -t ${SESSION} 2>/dev/null`); } catch {}
    execSync(
        `tmux new-session -s ${SESSION} 'caffeinate -disu bash -c "while true; do npm start; sleep 2; done"'`,
        { stdio: 'inherit' }
    );
} else {
    // Windows: run directly in current terminal
    function spawnApp() {
        const child = spawn(process.execPath, ['backend/dist/index.js'], { stdio: 'inherit' });
        child.on('close', (code) => {
            console.log(`\nProcess exited (code ${code}), restarting in 2s...\n`);
            setTimeout(spawnApp, 2000);
        });
    }
    spawnApp();
}
