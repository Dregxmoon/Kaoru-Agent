interface Window {
  kaoruI18n: {
    t(key: string): string;
    format(key: string, values?: Record<string, unknown>): string;
    has(key: string): boolean;
    apply(): void;
    setLanguage(value: string): Promise<boolean>;
    readonly language: string;
  };
}
