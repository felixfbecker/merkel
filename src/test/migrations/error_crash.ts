export function up(): Promise<void> {
    process.nextTick(() => {
        throw new Error()
    })
    return new Promise<void>(() => undefined)
}
