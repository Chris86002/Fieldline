export function waitForServer(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) {
        child.kill();
        reject(error);
      } else resolve();
    };
    const onMessage = (message) => {
      if (message.type === "ready") finish();
      if (message.type === "error") finish(new Error(message.code));
    };
    const onExit = () => finish(new Error("SERVER_EXITED"));
    const timer = setTimeout(() => finish(new Error("START_TIMEOUT")), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
