export default function formatDuration(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, Number(milliseconds) || 0);
  const totalSeconds = safeMilliseconds / 1000;

  if (totalSeconds < 60) {
    const precision = totalSeconds < 10 ? 2 : 1;
    const seconds = totalSeconds.toFixed(precision).replace(/\.?0+$/, '');
    return `${seconds}sec`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds % 60);
    return `${totalMinutes}min${seconds ? ` ${seconds}sec` : ''}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes ? ` ${minutes}min` : ''}`;
}
