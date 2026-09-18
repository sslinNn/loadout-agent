// node-notifier ships no type declarations and no @types package tracks its
// current major version. Only the notify() call this package uses is typed;
// keep this minimal rather than pulling in a mismatched @types package.
declare module "node-notifier" {
  interface NotificationOptions {
    title?: string;
    message?: string;
    [key: string]: unknown;
  }

  interface Notifier {
    notify(options: NotificationOptions, callback?: (err: Error | null, response: unknown) => void): void;
  }

  const notifier: Notifier;
  export default notifier;
}
