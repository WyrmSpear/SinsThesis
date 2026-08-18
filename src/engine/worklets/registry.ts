/** Base names of every worklet bundle in public/worklets/. */
export const WORKLET_MODULES = ['passthrough'] as const

export const workletUrl = (name: string): string => `/worklets/${name}.js`
