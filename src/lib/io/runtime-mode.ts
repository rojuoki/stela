export function ioLiveAcquisitionEnabled(): boolean {
  return process.env.STELA_IO_WEB_ONLY !== "1";
}
