import { createApp } from 'vue';
import ClickOutsideElement from './click-outside-element';
import LocalizedVTooltip from './localized-v-tooltip';
import tooltipOptions from './tooltip-options';
import VueAposI18Next from './i18next';

/* Vue.use(LocalizedVTooltip, tooltipOptions); */
/* Vue.use(ClickOutsideElement); */
/* Vue.use(VueAposI18Next, { */
/*   // Module aliases are not available yet when this code executes */
/*   i18n: apos.modules['@apostrophecms/i18n'] */
/* }); */

/* export default Vue; */


export default (appConfig) => {
const app = createApp(appConfig)


  app.use(LocalizedVTooltip, tooltipOptions);
  app.use(ClickOutsideElement);
  app.use(VueAposI18Next, {
    // Module aliases are not available yet when this code executes
    i18n: apos.modules['@apostrophecms/i18n']
  });

  return app
}
