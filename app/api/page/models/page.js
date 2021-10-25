"use strict";

const { createSlug } = require("../../../utils/string");

/**
 * Read the documentation (https://strapi.io/documentation/developer-docs/latest/development/backend-customization.html#lifecycle-hooks)
 * to customize this model
 */

module.exports = {
  lifecycles: {
    beforeCreate: async (data) => {
      if (!data.slug) {
        data.slug = createSlug(data.title);
      } else {
        data.slug = createSlug(data.slug);
      }
    },

    beforeUpdate: async (params, data) => {
      console.log(data);
      if (!data.slug) {
        data.slug = createSlug(data.title);
      } else {
        data.slug = createSlug(data.slug);
      }
    },
  },
};
