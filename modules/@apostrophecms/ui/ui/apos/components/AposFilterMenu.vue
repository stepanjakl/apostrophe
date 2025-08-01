<template>
  <AposContextMenu
    :button="button"
    menu-placement="bottom"
  >
    <div class="apos-filters-menu">
      <div
        v-for="set in filterSets"
        :key="set.key"
        class="apos-filters-menu__set"
      >
        <component
          :is="map[set.field.type]"
          :field="set.field"
          :model-value="set.value"
          :status="set.status"
          :icon="
            set.field.type === 'select' ? 'unfold-more-horizontal-icon' : ''
          "
          :no-blur-emit="true"
          @update:model-value="input($event, set.name)"
        />
      </div>
    </div>
  </AposContextMenu>
</template>

<script>
export default {
  props: {
    filters: {
      type: Array,
      required: true
    },
    choices: {
      type: Object,
      required: false,
      default() {
        return {};
      }
    },
    values: {
      type: Object,
      required: false,
      default() {
        return {};
      }
    },
    button: {
      type: Object,
      default() {
        return {
          label: 'apostrophe:filter',
          icon: 'chevron-down-icon',
          modifiers: [ 'icon-right', 'small' ],
          type: 'outline'
        };
      }
    }
  },
  emits: [ 'input' ],
  data() {
    return {
      map: {
        radio: 'AposInputRadio',
        checkbox: 'AposInputCheckboxes',
        select: 'AposInputSelect'
      },
      generation: 0
    };
  },
  computed: {
    filterSets() {
      const sets = [];
      this.filters.forEach(filter => {
        sets.push({
          name: filter.name,
          key: `${this.generation}:${filter.name}`,
          field: {
            name: filter.name,
            type: filter.inputType || 'select',
            label: filter.label || filter.name,
            choices: this.addNullChoice(
              filter,
              this.choices[filter.name] || filter.choices
            ),
            def: filter.def
          },
          value: {
            data: this.values[filter.name]
          },
          status: {}
        });
      });
      return sets;
    }
  },
  watch: {
    choices() {
      // Need this to build a key that v-for doesn't take as
      // permission to display an old version of the filter
      // even though the choices have changed
      this.generation++;
    }
  },
  methods: {
    input(value, filterName) {
      this.$emit('input', filterName, value);
    },
    addNullChoice(filter, choices) {
      if (filter.required || filter.inputType === 'checkbox') {
        return choices;
      }
      if (!choices) {
        // Still pending
        return [
          {
            label: 'apostrophe:filterMenuLoadingChoices',
            value: filter.def
          }
        ];
      }
      if (choices.find(choice => choice.value === null)) {
        return choices;
      }
      return [
        {
          label: filter.nullLabel,
          value: null
        }
      ].concat(choices);
    }
  }
};
</script>

<style lang="scss" scoped>
.apos-filters-menu {
  min-width: 140px;

  :deep(.apos-input--select) {
    padding-top: 0;
    padding-bottom: 0;
    background-color: var(--a-base-10);
    font-style: italic;
  }

  :deep(.apos-choice-label) {
    padding-right: $spacing-half;
    padding-left: $spacing-half;
  }
}

.apos-filters-menu :deep(.apos-field__label) {
  display: block;
  width: 100%;
  margin-bottom: $spacing-base + $spacing-half;
  padding-bottom: $spacing-half;
  border-bottom: 1px solid var(--a-base-9);
  color: var(--a-base-2);
}

.apos-filters-menu__set {
  margin: 0 0 $spacing-double + $spacing-half;

  &:last-child {
    margin-bottom: 0;
  }
}
</style>
