import { defineConfig } from 'eslint/config'
import * as config from '@lvce-editor/eslint-config'

export default defineConfig([
  ...config.default,
  ...config.recommendedActions,
  {
    rules: {
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
      'github-actions/ci-versions': 'off',
      'unicorn/no-top-level-side-effects': 'off',
    },
  },
])
